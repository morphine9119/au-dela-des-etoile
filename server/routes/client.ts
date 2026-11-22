import { Router } from '../http/express-lite.ts';
import { z } from 'zod';
import { requireAuth, writeAuditLog } from '../auth.ts';
import { db, nowIso, uuid } from '../db.ts';
import { hasAppointmentConflict } from '../services/availability.ts';
import {
  awardLoyaltyPointsAtomic,
  calculateFinancialSplit,
  calculateLoyaltyPointsForSpend,
  creditWalletAtomic,
  debitWalletAtomic,
  ensureWalletExists,
  finalizeConsultationAtomic,
  resolveCommissionRateBp,
} from '../services/finance.ts';
import { getAvailableProvidersForCountry, isProviderConfigured, verifyWebhookSignature, type PaymentProviderId } from '../services/paymentGateway.ts';
import { getTelephonyProviderStatus } from '../services/telephonyAdapter.ts';
import { broadcastToRoom, handleAuthorizedChatMessage } from '../ws.ts';
import { SUPPORT_STATUS_MESSAGES } from '../../src/lib/supportStatusMessages.ts';

export const clientRouter = Router();

// Public webhook endpoint before requireAuth (verified via HMAC signature)
clientRouter.post('/payments/webhook/:provider', (req, res) => {
  const provider = req.params.provider as PaymentProviderId;
  const sig = req.headers['x-signature'] as string | undefined;
  const rawBody = JSON.stringify(req.body || {});
  if (!verifyWebhookSignature({ provider, rawBody, signatureHeader: sig })) {
    res.status(401).json({ error: 'Signature webhook invalide' });
    return;
  }
  res.json({ received: true });
});

function isFreeOfferEnabled(): boolean {
  const row = db.prepare("SELECT value_json FROM platform_settings WHERE key = 'free_offer_enabled'").get() as
    | { value_json: string }
    | undefined;
  if (!row) return true;
  try {
    return Boolean(JSON.parse(row.value_json));
  } catch {
    return true;
  }
}

clientRouter.use(requireAuth);

clientRouter.get('/dashboard', (req, res) => {
  const userId = req.authUser!.id;
  ensureWalletExists(userId);

  const wallet = db.prepare('SELECT available_cents, pending_cents, currency FROM wallets WHERE user_id = ?').get(userId);
  const loyalty = db.prepare('SELECT points_balance, lifetime_points, tier, referral_code FROM loyalty_accounts WHERE user_id = ?').get(userId);
  const recentConsultations = db
    .prepare(`
      SELECT c.*, ep.display_name as expert_name, ep.slug as expert_slug, ep.avatar_url as expert_avatar, es.title as service_title
      FROM consultations c
      JOIN expert_profiles ep ON ep.id = c.expert_id
      JOIN expert_services es ON es.id = c.service_id
      WHERE c.client_id = ?
      ORDER BY c.created_at DESC
      LIMIT 5
    `)
    .all(userId);

  const upcomingAppointments = db
    .prepare(`
      SELECT a.*, ep.display_name as expert_name, ep.slug as expert_slug, es.title as service_title
      FROM appointments a
      JOIN expert_profiles ep ON ep.id = a.expert_id
      JOIN expert_services es ON es.id = a.service_id
      WHERE a.client_id = ? AND a.status IN ('confirmed', 'rescheduled') AND a.scheduled_start >= ?
      ORDER BY a.scheduled_start ASC
      LIMIT 5
    `)
    .all(userId, nowIso());

  const favorites = db
    .prepare(`
      SELECT ep.id, ep.slug, ep.display_name, ep.specialty, ep.avatar_url, ep.presence_status, ep.rating_avg_bp
      FROM favorites f
      JOIN expert_profiles ep ON ep.id = f.expert_id
      WHERE f.client_id = ?
    `)
    .all(userId);

  const recentTransactions = db
    .prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 6')
    .all(userId);

  const notifications = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 6')
    .all(userId);

  const unreadMessages = (
    db
      .prepare(`
        SELECT COUNT(*) as c
        FROM (
          SELECT m.id
          FROM chat_messages m
          JOIN chat_conversations conv ON conv.id = m.conversation_id
          WHERE conv.client_id = ? AND m.sender_id != ? AND m.is_read = 0
          UNION ALL
          SELECT sm.id
          FROM support_messages sm
          JOIN support_tickets st ON st.id = sm.ticket_id
          WHERE st.user_id = ? AND st.archived_at IS NULL AND sm.is_staff = 1 AND sm.is_read = 0
          UNION ALL
          SELECT cr.id
          FROM contact_message_replies cr
          JOIN contact_messages cm ON cm.id = cr.contact_message_id
          WHERE cm.user_id = ? AND cm.archived_at IS NULL AND cr.is_staff = 1 AND cr.is_read = 0
        )
      `)
      .get(userId, userId, userId, userId) as { c: number }
  ).c;

  res.json({
    wallet,
    loyalty,
    recentConsultations,
    upcomingAppointments,
    favorites,
    recentTransactions,
    notifications,
    unreadMessages,
  });
});

clientRouter.patch('/profile', (req, res) => {
  const schema = z.object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    phone: z.string().max(40).optional().default(''),
    preferredLanguage: z.enum(['en', 'fr', 'ar']),
    timezone: z.string().min(2).max(64),
    marketingConsent: z.boolean().optional(),
    emailBookings: z.boolean().optional(),
    emailMessages: z.boolean().optional(),
    emailPromotions: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Données de profil invalides' });
    return;
  }
  const userId = req.authUser!.id;
  const ts = nowIso();
  db.prepare(`
    UPDATE client_profiles
    SET first_name = ?, last_name = ?, phone = ?, preferred_language = ?, timezone = ?, marketing_consent = ?, updated_at = ?
    WHERE user_id = ?
  `).run(
    parsed.data.firstName.trim(),
    parsed.data.lastName.trim(),
    parsed.data.phone.trim() || null,
    parsed.data.preferredLanguage,
    parsed.data.timezone,
    parsed.data.marketingConsent ? 1 : 0,
    ts,
    userId
  );

  if (parsed.data.emailBookings !== undefined) {
    db.prepare(`
      INSERT INTO notification_preferences (user_id, email_bookings, email_messages, email_promotions, in_app_all)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        email_bookings = excluded.email_bookings,
        email_messages = excluded.email_messages,
        email_promotions = excluded.email_promotions
    `).run(userId, parsed.data.emailBookings ? 1 : 0, parsed.data.emailMessages ? 1 : 0, parsed.data.emailPromotions ? 1 : 0);
  }

  res.json({ ok: true });
});

clientRouter.get('/profile', (req, res) => {
  const userId = req.authUser!.id;
  const profile = db.prepare('SELECT * FROM client_profiles WHERE user_id = ?').get(userId);
  const preferences = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId);
  res.json({ profile, preferences });
});

// Favorites
clientRouter.get('/favorites', (req, res) => {
  const rows = db
    .prepare(`
      SELECT ep.*, (SELECT MIN(price_cents) FROM expert_services es WHERE es.expert_id = ep.id AND es.is_active = 1) as min_price_cents
      FROM favorites f
      JOIN expert_profiles ep ON ep.id = f.expert_id
      WHERE f.client_id = ?
    `)
    .all(req.authUser!.id);
  res.json({ favorites: rows });
});

clientRouter.post('/favorites/:expertId', (req, res) => {
  const userId = req.authUser!.id;
  const expertId = req.params.expertId;
  const existing = db.prepare('SELECT id FROM favorites WHERE client_id = ? AND expert_id = ?').get(userId, expertId) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
    res.json({ favorited: false });
  } else {
    db.prepare('INSERT INTO favorites (id, client_id, expert_id, created_at) VALUES (?, ?, ?, ?)').run(uuid(), userId, expertId, nowIso());
    res.json({ favorited: true });
  }
});

// Consultations & Chat
clientRouter.get('/consultations', (req, res) => {
  const rows = db
    .prepare(`
      SELECT c.*, ep.display_name as expert_name, ep.slug as expert_slug, es.title as service_title,
        (SELECT id FROM reviews r WHERE r.consultation_id = c.id LIMIT 1) as review_id
      FROM consultations c
      JOIN expert_profiles ep ON ep.id = c.expert_id
      JOIN expert_services es ON es.id = c.service_id
      WHERE c.client_id = ?
      ORDER BY c.created_at DESC
    `)
    .all(req.authUser!.id);
  res.json({ consultations: rows });
});

clientRouter.post('/consultations/start', (req, res) => {
  const schema = z.object({
    expertId: z.string().min(1),
    serviceId: z.string().min(1),
    couponCode: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'La sélection du conseiller et du service est requise' });
    return;
  }

  const userId = req.authUser!.id;
  const expert = db.prepare("SELECT * FROM expert_profiles WHERE id = ? AND status = 'approved'").get(parsed.data.expertId) as
    | { id: string; user_id: string; display_name: string }
    | undefined;
  if (!expert) {
    res.status(404).json({ error: 'Conseiller introuvable ou indisponible' });
    return;
  }
  if (expert.user_id === userId) {
    res.status(400).json({ error: 'Vous ne pouvez pas démarrer une consultation avec votre propre profil de conseiller' });
    return;
  }

  const service = db.prepare('SELECT * FROM expert_services WHERE id = ? AND expert_id = ? AND is_active = 1').get(parsed.data.serviceId, expert.id) as
    | { id: string; service_type: string; title: string; price_cents: number }
    | undefined;
  if (!service) {
    res.status(404).json({ error: 'Service sélectionné introuvable' });
    return;
  }

  // Phone consultation requires configured telephony provider when not using free discovery ticket
  if (service.service_type === 'phone_per_minute' && !isFreeOfferEnabled()) {
    const telephony = getTelephonyProviderStatus();
    if (!telephony.isConfigured) {
      res.status(503).json({
        error: 'Prestataire téléphonique non configuré dans cet environnement',
        telephony,
      });
      return;
    }
  }

  const freeOffer = isFreeOfferEnabled();
  const effectiveUnitPriceCents = freeOffer ? 0 : service.price_cents;

  ensureWalletExists(userId);
  const wallet = db.prepare('SELECT available_cents FROM wallets WHERE user_id = ?').get(userId) as { available_cents: number };
  if (effectiveUnitPriceCents > 0 && wallet.available_cents < effectiveUnitPriceCents) {
    res.status(402).json({
      error: `Solde de portefeuille insuffisant (${(wallet.available_cents / 100).toFixed(2)} €). Minimum requis : ${(effectiveUnitPriceCents / 100).toFixed(2)} €.`,
    });
    return;
  }

  const billingModel =
    service.service_type === 'chat_per_message'
      ? 'per_message'
      : service.service_type === 'chat_per_minute' || service.service_type === 'phone_per_minute'
      ? 'per_minute'
      : 'fixed';

  const ts = nowIso();
  const consultId = uuid();
  const convId = uuid();
  const commissionBp = resolveCommissionRateBp(expert.id, service.service_type);

  try {
    db.transaction(() => {
      let initialGross = 0;
      let initialUnits = 0;

      if (billingModel === 'fixed') {
        if (effectiveUnitPriceCents > 0) {
          debitWalletAtomic({
            userId,
            amountCents: effectiveUnitPriceCents,
            referenceType: 'consultation',
            referenceId: consultId,
            description: `${service.title} avec ${expert.display_name}`,
            idempotencyKey: `consult-fixed-${consultId}`,
          });
        }
        initialGross = effectiveUnitPriceCents;
        initialUnits = 1;
      }

      const split = calculateFinancialSplit(initialGross, commissionBp);

      db.prepare(`
        INSERT INTO consultations (id, client_id, expert_id, service_id, service_type, billing_model, unit_price_cents, currency, status, units_consumed, gross_amount_cents, commission_bp, commission_cents, expert_net_cents, started_at, is_demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        consultId,
        userId,
        expert.id,
        service.id,
        service.service_type,
        billingModel,
        effectiveUnitPriceCents,
        initialUnits,
        split.grossCents,
        commissionBp,
        split.commissionCents,
        split.expertNetCents,
        ts,
        req.authUser!.is_demo ? 1 : 0,
        ts,
        ts
      );

      db.prepare('INSERT INTO chat_conversations (id, consultation_id, client_id, expert_id, status, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(convId, consultId, userId, expert.id, 'open', ts, ts);

      db.prepare('INSERT INTO notifications (id, user_id, type, title, body, link_url, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
        .run(uuid(), expert.user_id, 'consultation_request', 'Nouvelle consultation en direct', `Un client a démarré : ${service.title}${freeOffer ? ' (Offre 0,00 €)' : ''}.`, '/expert/messages', ts);
    })();
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Impossible de démarrer la consultation' });
    return;
  }

  res.status(201).json({ consultationId: consultId, conversationId: convId, appliedFreeOffer: freeOffer });
});

clientRouter.post('/consultations/:id/end', (req, res) => {
  const c = db.prepare('SELECT id, client_id FROM consultations WHERE id = ?').get(req.params.id) as
    | { id: string; client_id: string }
    | undefined;
  if (!c || c.client_id !== req.authUser!.id) {
    res.status(404).json({ error: 'Consultation introuvable' });
    return;
  }
  const finalized = finalizeConsultationAtomic(c.id);
  db.prepare("UPDATE chat_conversations SET status = 'closed' WHERE consultation_id = ?").run(c.id);
  res.json({ consultation: finalized });
});

// Conversations & Messages
clientRouter.get('/conversations', (req, res) => {
  const rows = db
    .prepare(`
      SELECT conv.*, ep.display_name as expert_name, ep.slug as expert_slug, ep.avatar_url as expert_avatar, ep.presence_status,
        c.billing_model, c.unit_price_cents, c.status as consultation_status, c.gross_amount_cents, c.units_consumed,
        (SELECT content FROM chat_messages m WHERE m.conversation_id = conv.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = conv.id AND m.sender_id != ? AND m.is_read = 0) as unread_count
      FROM chat_conversations conv
      JOIN expert_profiles ep ON ep.id = conv.expert_id
      LEFT JOIN consultations c ON c.id = conv.consultation_id
      WHERE conv.client_id = ?
      ORDER BY COALESCE(conv.last_message_at, conv.created_at) DESC
    `)
    .all(req.authUser!.id, req.authUser!.id);
  res.json({ conversations: rows });
});

clientRouter.get('/conversations/:id/messages', (req, res) => {
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id = ? AND client_id = ?').get(req.params.id, req.authUser!.id);
  if (!conv) {
    res.status(404).json({ error: 'Conversation introuvable' });
    return;
  }
  db.prepare('UPDATE chat_messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ?').run(req.params.id, req.authUser!.id);
  const messages = db
    .prepare(`
      SELECT m.*, cp.first_name, cp.last_name
      FROM chat_messages m
      LEFT JOIN client_profiles cp ON cp.user_id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
      LIMIT 100
    `)
    .all(req.params.id);
  res.json({ messages });
});

clientRouter.post('/conversations/:id/messages', (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content || content.length > 4000) {
    res.status(400).json({ error: 'Le message doit contenir entre 1 et 4000 caractères' });
    return;
  }
  const result = handleAuthorizedChatMessage({
    conversationId: req.params.id,
    senderId: req.authUser!.id,
    content,
  });
  if ('error' in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  broadcastToRoom(req.params.id, 'message:created', result.message);
  res.status(201).json({ message: result.message });
});

clientRouter.post('/conversations/:id/report', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 5) {
    res.status(400).json({ error: 'Veuillez préciser brièvement le motif du signalement' });
    return;
  }
  db.prepare('INSERT INTO abuse_reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), req.authUser!.id, 'conversation', req.params.id, reason, 'open', nowIso());
  res.status(201).json({ ok: true });
});

// Appointments
clientRouter.get('/appointments', (req, res) => {
  const rows = db
    .prepare(`
      SELECT a.*, ep.display_name as expert_name, ep.slug as expert_slug, ep.avatar_url as expert_avatar, es.title as service_title
      FROM appointments a
      JOIN expert_profiles ep ON ep.id = a.expert_id
      JOIN expert_services es ON es.id = a.service_id
      WHERE a.client_id = ?
      ORDER BY a.scheduled_start DESC
    `)
    .all(req.authUser!.id);
  res.json({ appointments: rows });
});

clientRouter.post('/appointments', (req, res) => {
  const schema = z.object({
    expertId: z.string().min(1),
    serviceId: z.string().min(1),
    scheduledStart: z.string().min(10),
    clientTimezone: z.string().min(2).max(64).default('Europe/Paris'),
    notes: z.string().max(500).optional().default(''),
    couponCode: z.string().max(40).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Informations de rendez-vous invalides' });
    return;
  }

  const userId = req.authUser!.id;
  const expert = db.prepare("SELECT * FROM expert_profiles WHERE id = ? AND status = 'approved'").get(parsed.data.expertId) as
    | { id: string; user_id: string; display_name: string }
    | undefined;
  const service = db.prepare('SELECT * FROM expert_services WHERE id = ? AND expert_id = ? AND is_active = 1').get(parsed.data.serviceId, parsed.data.expertId) as
    | { id: string; title: string; price_cents: number; duration_minutes: number | null; service_type: string }
    | undefined;

  if (!expert || !service) {
    res.status(404).json({ error: 'Conseiller ou service introuvable' });
    return;
  }

  const duration = service.duration_minutes || 45;
  const startDate = new Date(parsed.data.scheduledStart);
  if (Number.isNaN(startDate.getTime()) || startDate.getTime() <= Date.now()) {
    res.status(400).json({ error: 'Le créneau sélectionné doit être dans le futur' });
    return;
  }
  const endDate = new Date(startDate.getTime() + duration * 60000);

  let finalPriceCents = isFreeOfferEnabled() ? 0 : service.price_cents;
  let couponIdToMark: string | null = null;

  if (finalPriceCents > 0 && parsed.data.couponCode) {
    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND is_active = 1').get(parsed.data.couponCode.trim().toUpperCase()) as
      | { id: string; discount_type: string; discount_value: number; max_uses: number | null; used_count: number; expires_at: string | null }
      | undefined;
    if (coupon && (!coupon.expires_at || new Date(coupon.expires_at).getTime() > Date.now())) {
      const alreadyUsed = db.prepare('SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?').get(coupon.id, userId);
      if (!alreadyUsed && (!coupon.max_uses || coupon.used_count < coupon.max_uses)) {
        if (coupon.discount_type === 'fixed_cents') {
          finalPriceCents = Math.max(0, finalPriceCents - coupon.discount_value);
        } else {
          finalPriceCents = Math.max(0, finalPriceCents - Math.round((finalPriceCents * coupon.discount_value) / 10000));
        }
        couponIdToMark = coupon.id;
      }
    }
  }

  const ts = nowIso();
  const apptId = uuid();

  try {
    db.transaction(() => {
      if (hasAppointmentConflict(expert.id, startDate.toISOString(), endDate.toISOString())) {
        throw new Error('SLOT_CONFLICT');
      }

      if (finalPriceCents > 0) {
        debitWalletAtomic({
          userId,
          amountCents: finalPriceCents,
          referenceType: 'appointment',
          referenceId: apptId,
          description: `Rendez-vous : ${service.title} avec ${expert.display_name}`,
          idempotencyKey: `appt-book-${apptId}`,
        });
      }

      db.prepare(`
        INSERT INTO appointments (id, client_id, expert_id, service_id, scheduled_start, scheduled_end, client_timezone, status, price_cents, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)
      `).run(apptId, userId, expert.id, service.id, startDate.toISOString(), endDate.toISOString(), parsed.data.clientTimezone, finalPriceCents, parsed.data.notes, ts, ts);

      // Create consultation & earnings record
      const consultId = uuid();
      const commissionBp = resolveCommissionRateBp(expert.id, service.service_type);
      const split = calculateFinancialSplit(finalPriceCents, commissionBp);

      db.prepare(`
        INSERT INTO consultations (id, client_id, expert_id, service_id, service_type, billing_model, unit_price_cents, currency, status, units_consumed, gross_amount_cents, commission_bp, commission_cents, expert_net_cents, started_at, is_demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'fixed', ?, 'EUR', 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(consultId, userId, expert.id, service.id, service.service_type, finalPriceCents, split.grossCents, commissionBp, split.commissionCents, split.expertNetCents, startDate.toISOString(), req.authUser!.is_demo ? 1 : 0, ts, ts);

      if (couponIdToMark) {
        db.prepare('INSERT INTO coupon_redemptions (id, coupon_id, user_id, consultation_id, created_at) VALUES (?, ?, ?, ?, ?)').run(uuid(), couponIdToMark, userId, consultId, ts);
        db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(couponIdToMark);
      }

      db.prepare('INSERT INTO notifications (id, user_id, type, title, body, link_url, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
        .run(uuid(), expert.user_id, 'booking_confirmation', 'Nouveau rendez-vous confirmé', `${service.title} prévu le ${startDate.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '/expert/consultations', ts);
      db.prepare('INSERT INTO notifications (id, user_id, type, title, body, link_url, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
        .run(uuid(), userId, 'booking_confirmation', 'Rendez-vous confirmé', `Votre séance avec ${expert.display_name} est confirmée.`, '/account/appointments', ts);
    })();
  } catch (err) {
    if (err instanceof Error && err.message === 'SLOT_CONFLICT') {
      res.status(409).json({ error: 'Ce créneau vient d’être réservé. Veuillez en choisir un autre.' });
      return;
    }
    if (err instanceof Error && err.message === 'INSUFFICIENT_WALLET_BALANCE') {
      res.status(402).json({ error: 'Solde insuffisant pour confirmer ce rendez-vous.' });
      return;
    }
    res.status(400).json({ error: 'Impossible de confirmer le rendez-vous' });
    return;
  }

  res.status(201).json({ ok: true, appointmentId: apptId });
});

clientRouter.post('/appointments/:id/cancel', (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND client_id = ?').get(req.params.id, req.authUser!.id) as
    | { id: string; status: string; price_cents: number; scheduled_start: string }
    | undefined;
  if (!appt || appt.status === 'cancelled' || appt.status === 'completed') {
    res.status(404).json({ error: 'Rendez-vous actif introuvable' });
    return;
  }

  const ts = nowIso();
  db.transaction(() => {
    db.prepare("UPDATE appointments SET status = 'cancelled', cancellation_reason = ?, updated_at = ? WHERE id = ?")
      .run(typeof req.body?.reason === 'string' ? req.body.reason : 'Annulé par le client', ts, appt.id);
    if (appt.price_cents > 0) {
      creditWalletAtomic({
        userId: req.authUser!.id,
        amountCents: appt.price_cents,
        type: 'refund',
        referenceType: 'appointment_cancellation',
        referenceId: appt.id,
        description: 'Remboursement suite à l’annulation du rendez-vous',
        idempotencyKey: `appt-cancel-refund-${appt.id}`,
      });
    }
  })();

  res.json({ ok: true });
});

// Wallet & Sandbox / Provider Checkout
clientRouter.get('/wallet', (req, res) => {
  const userId = req.authUser!.id;
  ensureWalletExists(userId);
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  const transactions = db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId);
  const payments = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(userId);
  const refunds = db.prepare('SELECT * FROM refunds WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(userId);
  const country = typeof req.query.country === 'string' ? req.query.country : 'FR';
  const providers = getAvailableProvidersForCountry(country);

  res.json({ wallet, transactions, payments, refunds, providers, country });
});

clientRouter.post('/payments/checkout', (req, res) => {
  const schema = z.object({
    amountCents: z.number().int().min(500).max(100000),
    provider: z.enum(['stripe', 'cmi', 'paytabs', 'paypal', 'sandbox_demo']),
    countryCode: z.string().length(2).default('FR'),
    idempotencyKey: z.string().min(8).max(100),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Paramètres de paiement invalides' });
    return;
  }

  const { amountCents, provider, countryCode, idempotencyKey } = parsed.data;
  const userId = req.authUser!.id;

  // Idempotency check
  const existingPay = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(idempotencyKey);
  if (existingPay) {
    res.json({ payment: existingPay, deduplicated: true });
    return;
  }

  if (provider !== 'sandbox_demo') {
    if (!isProviderConfigured(provider)) {
      res.status(503).json({
        error: `Le prestataire de paiement réel (${provider}) n’est pas configuré dans cet environnement. Les transactions réelles ne peuvent pas être simulées.`,
      });
      return;
    }
    const payId = uuid();
    const ts = nowIso();
    db.prepare(`
      INSERT INTO payments (id, user_id, provider, idempotency_key, amount_cents, currency, status, country_code, is_sandbox, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'EUR', 'pending', ?, 0, ?, ?)
    `).run(payId, userId, provider, idempotencyKey, amountCents, countryCode.toUpperCase(), ts, ts);
    res.status(202).json({ paymentId: payId, status: 'pending_webhook_verification' });
    return;
  }

  // Sandbox/Demo Test Credit (explicitly flagged is_sandbox = 1; never disguised as live card settlement)
  if (!isProviderConfigured('sandbox_demo')) {
    res.status(403).json({ error: 'Les crédits de test sandbox sont désactivés en production.' });
    return;
  }

  const payId = uuid();
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO payments (id, user_id, provider, provider_intent_id, idempotency_key, amount_cents, currency, status, country_code, is_sandbox, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'sandbox_demo', ?, ?, ?, 'EUR', 'sandbox_test', ?, 1, ?, ?, ?)
    `).run(
      payId,
      userId,
      `sandbox_${payId.slice(0, 8)}`,
      idempotencyKey,
      amountCents,
      countryCode.toUpperCase(),
      JSON.stringify({ mode: 'DEMO_SANDBOX_TEST_CREDIT' }),
      ts,
      ts
    );

    creditWalletAtomic({
      userId,
      amountCents,
      type: 'credit',
      referenceType: 'sandbox_payment',
      referenceId: payId,
      description: `Crédit de test Sandbox (${(amountCents / 100).toFixed(2)} € — Hors production)`,
      idempotencyKey: `wallet-pay-${idempotencyKey}`,
    });
  })();

  writeAuditLog({ actorId: userId, action: 'payment.sandbox_test_credit', entityType: 'payment', entityId: payId, details: { amountCents } });
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(payId);
  res.status(201).json({ payment, isSandbox: true });
});

clientRouter.post('/refunds', (req, res) => {
  const schema = z.object({
    consultationId: z.string().optional(),
    paymentId: z.string().optional(),
    amountCents: z.number().int().positive(),
    reason: z.string().min(10).max(1000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Un montant et un motif valides (min. 10 caractères) sont requis' });
    return;
  }
  const id = uuid();
  const ts = nowIso();
  db.prepare(`
    INSERT INTO refunds (id, payment_id, consultation_id, user_id, amount_cents, reason, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)
  `).run(id, parsed.data.paymentId ?? null, parsed.data.consultationId ?? null, req.authUser!.id, parsed.data.amountCents, parsed.data.reason.trim(), ts, ts);
  res.status(201).json({ ok: true, refundId: id });
});

// Reviews (strictly restricted to completed consultations owned by client)
clientRouter.post('/reviews', (req, res) => {
  const schema = z.object({
    consultationId: z.string().min(1),
    rating: z.number().int().min(1).max(5),
    comment: z.string().min(10).max(1500),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Une note (1 à 5) et un avis (min. 10 caractères) sont requis' });
    return;
  }

  const userId = req.authUser!.id;
  const consult = db
    .prepare("SELECT * FROM consultations WHERE id = ? AND client_id = ? AND status = 'completed'")
    .get(parsed.data.consultationId, userId) as { id: string; expert_id: string } | undefined;

  if (!consult) {
    res.status(403).json({ error: 'Les avis sont réservés à vos consultations terminées.' });
    return;
  }

  const dup = db.prepare('SELECT id FROM reviews WHERE consultation_id = ?').get(consult.id);
  if (dup) {
    res.status(409).json({ error: 'Vous avez déjà publié un avis pour cette consultation.' });
    return;
  }

  const ts = nowIso();
  const revId = uuid();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO reviews (id, consultation_id, client_id, expert_id, rating, comment, status, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)
    `).run(revId, consult.id, userId, consult.expert_id, parsed.data.rating, parsed.data.comment.trim(), req.authUser!.is_demo ? 1 : 0, ts, ts);

    const stats = db
      .prepare("SELECT COUNT(*) as cnt, AVG(rating) as avg_rating FROM reviews WHERE expert_id = ? AND status = 'published'")
      .get(consult.expert_id) as { cnt: number; avg_rating: number };

    db.prepare('UPDATE expert_profiles SET rating_avg_bp = ?, review_count = ?, updated_at = ? WHERE id = ?')
      .run(Math.round((stats.avg_rating || 0) * 100), stats.cnt, ts, consult.expert_id);
  })();

  res.status(201).json({ ok: true, reviewId: revId });
});

clientRouter.get('/reviews', (req, res) => {
  const rows = db
    .prepare(`
      SELECT r.*, ep.display_name as expert_name, ep.slug as expert_slug
      FROM reviews r
      JOIN expert_profiles ep ON ep.id = r.expert_id
      WHERE r.client_id = ?
      ORDER BY r.created_at DESC
    `)
    .all(req.authUser!.id);
  res.json({ reviews: rows });
});

// Loyalty & Rewards
clientRouter.get('/rewards', (req, res) => {
  const userId = req.authUser!.id;
  const account = db.prepare('SELECT * FROM loyalty_accounts WHERE user_id = ?').get(userId);
  const transactions = db.prepare('SELECT * FROM loyalty_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(userId);
  const campaigns = db.prepare('SELECT * FROM reward_campaigns WHERE is_active = 1').all();
  const redeemableCoupons = db.prepare('SELECT * FROM coupons WHERE is_active = 1 AND points_cost > 0').all();
  res.json({ account, transactions, campaigns, redeemableCoupons });
});

clientRouter.post('/rewards/daily-claim', (req, res) => {
  const userId = req.authUser!.id;
  const today = new Date().toISOString().slice(0, 10);
  const acc = db.prepare('SELECT * FROM loyalty_accounts WHERE user_id = ?').get(userId) as
    | { last_daily_claim_date: string | null }
    | undefined;
  if (!acc) {
    res.status(404).json({ error: 'Compte fidélité introuvable' });
    return;
  }
  if (acc.last_daily_claim_date === today) {
    res.status(409).json({ error: 'Bonus quotidien déjà réclamé aujourd’hui.' });
    return;
  }

  db.transaction(() => {
    db.prepare('UPDATE loyalty_accounts SET last_daily_claim_date = ? WHERE user_id = ?').run(today, userId);
    awardLoyaltyPointsAtomic({
      userId,
      points: 25,
      type: 'daily_claim',
      referenceId: today,
      description: `Récompense de connexion quotidienne (${today})`,
    });
  })();

  const updated = db.prepare('SELECT * FROM loyalty_accounts WHERE user_id = ?').get(userId);
  res.json({ ok: true, account: updated });
});

clientRouter.post('/rewards/redeem-coupon', (req, res) => {
  const couponId = typeof req.body?.couponId === 'string' ? req.body.couponId : '';
  const userId = req.authUser!.id;
  const coupon = db.prepare('SELECT * FROM coupons WHERE id = ? AND is_active = 1 AND points_cost > 0').get(couponId) as
    | { id: string; code: string; points_cost: number }
    | undefined;
  if (!coupon) {
    res.status(404).json({ error: 'Code avantage introuvable' });
    return;
  }

  try {
    db.transaction(() => {
      const acc = db.prepare('SELECT points_balance FROM loyalty_accounts WHERE user_id = ?').get(userId) as { points_balance: number };
      if (!acc || acc.points_balance < coupon.points_cost) {
        throw new Error('INSUFFICIENT_POINTS');
      }
      const next = acc.points_balance - coupon.points_cost;
      const ts = nowIso();
      db.prepare('UPDATE loyalty_accounts SET points_balance = ?, updated_at = ? WHERE user_id = ?').run(next, ts, userId);
      db.prepare('INSERT INTO loyalty_transactions (id, user_id, points_delta, type, reference_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(uuid(), userId, -coupon.points_cost, 'redemption', coupon.id, `Échange de points contre le code ${coupon.code}`, ts);
    })();
  } catch (err) {
    if (err instanceof Error && err.message === 'INSUFFICIENT_POINTS') {
      res.status(400).json({ error: 'Points Astraux insuffisants pour cette récompense.' });
      return;
    }
    res.status(400).json({ error: 'Impossible d’échanger la récompense' });
    return;
  }

  res.json({ ok: true, code: coupon.code });
});

// Notifications
clientRouter.get('/notifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40').all(req.authUser!.id);
  res.json({ notifications: rows });
});

clientRouter.post('/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.authUser!.id);
  res.json({ ok: true });
});

// Support Tickets
clientRouter.get('/support', (req, res) => {
  const tickets = db
    .prepare('SELECT id, user_id, category, priority, status, subject, created_at, updated_at FROM support_tickets WHERE user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC')
    .all(req.authUser!.id);
  const messages = db
    .prepare(`
      SELECT sm.*
      FROM support_messages sm
      JOIN support_tickets st ON st.id = sm.ticket_id
      WHERE st.user_id = ? AND st.archived_at IS NULL
      ORDER BY sm.created_at ASC
    `)
    .all(req.authUser!.id);
  res.json({ tickets, messages });
});

clientRouter.get('/support/inbox', (req, res) => {
  const statusMessages = Object.values(SUPPORT_STATUS_MESSAGES);
  const tickets = db.prepare(`
    SELECT * FROM (
      SELECT st.id, 'support' AS source, st.subject, st.status, st.category, st.created_at, st.updated_at,
        (SELECT content FROM support_messages sm WHERE sm.ticket_id = st.id ORDER BY sm.created_at DESC LIMIT 1) AS last_message,
        (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = st.id AND sm.is_staff = 1 AND sm.is_read = 0) AS unread_count,
        EXISTS(SELECT 1 FROM support_messages sm WHERE sm.ticket_id = st.id AND sm.is_staff = 1 AND sm.content NOT IN (?, ?, ?)) AS has_staff_reply
      FROM support_tickets st
      WHERE st.user_id = ? AND st.archived_at IS NULL
      UNION ALL
      SELECT cm.id, 'contact' AS source, cm.subject, cm.status, 'contact' AS category, cm.created_at, cm.updated_at,
        COALESCE((SELECT content FROM contact_message_replies cr WHERE cr.contact_message_id = cm.id ORDER BY cr.created_at DESC LIMIT 1), cm.message) AS last_message,
        (SELECT COUNT(*) FROM contact_message_replies cr WHERE cr.contact_message_id = cm.id AND cr.is_staff = 1 AND cr.is_read = 0) AS unread_count,
        EXISTS(SELECT 1 FROM contact_message_replies cr WHERE cr.contact_message_id = cm.id AND cr.is_staff = 1 AND cr.content NOT IN (?, ?, ?)) AS has_staff_reply
      FROM contact_messages cm
      WHERE cm.user_id = ? AND cm.archived_at IS NULL
    ) ORDER BY updated_at DESC
  `).all(
    ...statusMessages,
    req.authUser!.id,
    ...statusMessages,
    req.authUser!.id
  );
  res.json({ tickets });
});

clientRouter.post('/support', (req, res) => {
  const schema = z.object({
    category: z.string().min(2).max(60),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    subject: z.string().trim().min(4).max(160),
    message: z.string().trim().min(10).max(3000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Veuillez indiquer un objet et un message (min. 10 caractères)' });
    return;
  }
  const ts = nowIso();
  const ticketId = uuid();
  db.transaction(() => {
    db.prepare('INSERT INTO support_tickets (id, user_id, category, priority, status, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ticketId, req.authUser!.id, parsed.data.category, parsed.data.priority, 'in_progress', parsed.data.subject.trim(), ts, ts);
    db.prepare('INSERT INTO support_messages (id, ticket_id, sender_id, is_staff, content, created_at, is_read) VALUES (?, ?, ?, 0, ?, ?, 0)')
      .run(uuid(), ticketId, req.authUser!.id, parsed.data.message.trim(), ts);
  })();
  res.status(201).json({ ok: true, ticketId });
});

clientRouter.get('/support/:id/messages', (req, res) => {
  const ticket = db.prepare('SELECT id FROM support_tickets WHERE id = ? AND user_id = ? AND archived_at IS NULL')
    .get(req.params.id, req.authUser!.id);
  if (!ticket) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  db.prepare('UPDATE support_messages SET is_read = 1 WHERE ticket_id = ? AND is_staff = 1').run(req.params.id);
  const messages = db.prepare(`
    SELECT id, sender_id, is_staff, content, created_at
    FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC
  `).all(req.params.id);
  res.json({ messages });
});

clientRouter.get('/support/contact/:id/messages', (req, res) => {
  const contact = db.prepare(`
    SELECT id, subject, status, message, created_at FROM contact_messages
    WHERE id = ? AND user_id = ? AND archived_at IS NULL
  `).get(req.params.id, req.authUser!.id) as
    | { id: string; subject: string; status: string; message: string; created_at: string }
    | undefined;
  if (!contact) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  db.prepare('UPDATE contact_message_replies SET is_read = 1 WHERE contact_message_id = ? AND is_staff = 1').run(req.params.id);
  const replies = db.prepare(`
    SELECT id, sender_id, is_staff, content, created_at
    FROM contact_message_replies WHERE contact_message_id = ? ORDER BY created_at ASC
  `).all(req.params.id) as Array<Record<string, unknown>>;
  const messages = [
    { id: contact.id, sender_id: null, is_staff: 0, content: contact.message, created_at: contact.created_at },
    ...replies,
  ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  res.json({ messages });
});

clientRouter.post('/support/contact/:id/messages', (req, res) => {
  const contact = db.prepare('SELECT id, status FROM contact_messages WHERE id = ? AND user_id = ? AND archived_at IS NULL')
    .get(req.params.id, req.authUser!.id) as { id: string; status: string } | undefined;
  if (!contact) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  if (contact.status === 'resolved' || contact.status === 'closed') {
    res.status(409).json({ error: 'Cette discussion est résolue ou clôturée. Ouvrez un nouveau ticket pour continuer.' });
    return;
  }
  const staffReply = db.prepare('SELECT 1 FROM contact_message_replies WHERE contact_message_id = ? AND is_staff = 1 AND content NOT IN (?, ?, ?) LIMIT 1')
    .get(req.params.id, ...Object.values(SUPPORT_STATUS_MESSAGES));
  if (!staffReply) {
    res.status(409).json({ error: 'Vous pourrez répondre dès que l’équipe aura envoyé son premier message.' });
    return;
  }
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content || content.length > 4000) {
    res.status(400).json({ error: 'Le message doit contenir entre 1 et 4000 caractères' });
    return;
  }
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO contact_message_replies
        (id, contact_message_id, sender_id, is_staff, content, created_at, is_read)
      VALUES (?, ?, ?, 0, ?, ?, 0)
    `).run(uuid(), req.params.id, req.authUser!.id, content, ts);
    db.prepare("UPDATE contact_messages SET status = 'open', updated_at = ? WHERE id = ?").run(ts, req.params.id);
  })();
  res.status(201).json({ ok: true });
});

clientRouter.post('/support/:id/messages', (req, res) => {
  const ticket = db.prepare('SELECT id, status FROM support_tickets WHERE id = ? AND user_id = ? AND archived_at IS NULL')
    .get(req.params.id, req.authUser!.id) as { id: string; status: string } | undefined;
  if (!ticket) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    res.status(409).json({ error: 'Cette discussion est résolue ou clôturée. Ouvrez un nouveau ticket pour continuer.' });
    return;
  }
  const staffReply = db.prepare('SELECT 1 FROM support_messages WHERE ticket_id = ? AND is_staff = 1 AND content NOT IN (?, ?, ?) LIMIT 1')
    .get(req.params.id, ...Object.values(SUPPORT_STATUS_MESSAGES));
  if (!staffReply) {
    res.status(409).json({ error: 'Vous pourrez répondre dès que l’équipe aura envoyé son premier message.' });
    return;
  }
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) {
    res.status(400).json({ error: 'Le contenu du message est requis' });
    return;
  }
  const ts = nowIso();
  db.prepare('INSERT INTO support_messages (id, ticket_id, sender_id, is_staff, content, created_at, is_read) VALUES (?, ?, ?, 0, ?, ?, 0)')
    .run(uuid(), req.params.id, req.authUser!.id, content, ts);
  db.prepare("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?").run(ts, req.params.id);
  res.status(201).json({ ok: true });
});
