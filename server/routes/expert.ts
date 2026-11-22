import { Router } from '../http/express-lite.ts';
import { z } from 'zod';
import { requireRole, writeAuditLog } from '../auth.ts';
import { db, nowIso, uuid } from '../db.ts';
import { finalizeConsultationAtomic } from '../services/finance.ts';
import { broadcastPresence, broadcastToRoom, handleAuthorizedChatMessage } from '../ws.ts';

export const expertRouter = Router();
expertRouter.use(requireRole('expert', 'admin'));

function getExpertProfileForRequest(userId: string) {
  return db.prepare('SELECT * FROM expert_profiles WHERE user_id = ?').get(userId) as
    | (Record<string, unknown> & { id: string; user_id: string; display_name: string })
    | undefined;
}

expertRouter.get('/dashboard', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Profil de conseiller introuvable pour ce compte' });
    return;
  }

  const todayPrefix = new Date().toISOString().slice(0, 10);
  const monthPrefix = new Date().toISOString().slice(0, 7);

  const dailyConsultations = (
    db.prepare("SELECT COUNT(*) as c FROM consultations WHERE expert_id = ? AND created_at LIKE ?").get(expert.id, `${todayPrefix}%`) as { c: number }
  ).c;
  const monthlyConsultations = (
    db.prepare("SELECT COUNT(*) as c FROM consultations WHERE expert_id = ? AND created_at LIKE ?").get(expert.id, `${monthPrefix}%`) as { c: number }
  ).c;

  const earningsSummary = db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'available' THEN net_cents ELSE 0 END), 0) as available_cents,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN net_cents ELSE 0 END), 0) as pending_cents,
        COALESCE(SUM(net_cents), 0) as total_net_cents,
        COALESCE(SUM(gross_cents), 0) as total_gross_cents,
        COALESCE(SUM(commission_cents), 0) as total_commission_cents
      FROM expert_earnings
      WHERE expert_id = ?
    `)
    .get(expert.id);

  const withdrawnTotal = (
    db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM withdrawals WHERE expert_id = ? AND status IN ('pending', 'approved', 'paid')").get(expert.id) as {
      total: number;
    }
  ).total;

  const upcomingAppointments = db
    .prepare(`
      SELECT a.*, cp.first_name || ' ' || cp.last_name as client_name, es.title as service_title
      FROM appointments a
      JOIN client_profiles cp ON cp.user_id = a.client_id
      JOIN expert_services es ON es.id = a.service_id
      WHERE a.expert_id = ? AND a.status IN ('confirmed', 'rescheduled') AND a.scheduled_start >= ?
      ORDER BY a.scheduled_start ASC
      LIMIT 8
    `)
    .all(expert.id, nowIso());

  const recentReviews = db
    .prepare(`
      SELECT r.*, cp.first_name as client_name
      FROM reviews r
      LEFT JOIN client_profiles cp ON cp.user_id = r.client_id
      WHERE r.expert_id = ? AND r.status = 'published'
      ORDER BY r.created_at DESC
      LIMIT 6
    `)
    .all(expert.id);

  const services = db.prepare('SELECT * FROM expert_services WHERE expert_id = ? ORDER BY created_at ASC').all(expert.id);
  const availability = db.prepare('SELECT * FROM expert_availability WHERE expert_id = ? ORDER BY day_of_week ASC, start_time ASC').all(expert.id);

  res.json({
    expert,
    dailyConsultations,
    monthlyConsultations,
    earningsSummary,
    withdrawnTotal,
    upcomingAppointments,
    recentReviews,
    services,
    availability,
  });
});

expertRouter.post('/presence', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Profil de conseiller introuvable' });
    return;
  }
  const status = req.body?.presenceStatus;
  if (!['online', 'busy', 'offline'].includes(status)) {
    res.status(400).json({ error: 'Statut de présence invalide' });
    return;
  }
  db.prepare('UPDATE expert_profiles SET presence_status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), expert.id);
  broadcastPresence(expert.id, status);
  res.json({ ok: true, presenceStatus: status });
});

expertRouter.patch('/profile', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Profil de conseiller introuvable' });
    return;
  }
  const schema = z.object({
    displayName: z.string().min(2).max(100),
    headline: z.string().min(4).max(160),
    specialty: z.string().min(2).max(100),
    biography: z.string().min(20).max(4000),
    languages: z.array(z.string()).min(1),
    tools: z.array(z.string()),
    introVideoUrl: z.string().max(300).optional().default(''),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Champs de profil conseiller invalides' });
    return;
  }
  db.prepare(`
    UPDATE expert_profiles
    SET display_name = ?, headline = ?, specialty = ?, biography = ?, languages_json = ?, tools_json = ?, intro_video_url = ?, updated_at = ?
    WHERE id = ?
  `).run(
    parsed.data.displayName.trim(),
    parsed.data.headline.trim(),
    parsed.data.specialty.trim(),
    parsed.data.biography.trim(),
    JSON.stringify(parsed.data.languages),
    JSON.stringify(parsed.data.tools),
    parsed.data.introVideoUrl.trim() || null,
    nowIso(),
    expert.id
  );
  res.json({ ok: true });
});

expertRouter.post('/services', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Profil de conseiller introuvable' });
    return;
  }
  const schema = z.object({
    serviceType: z.enum(['chat_per_message', 'chat_per_minute', 'chat_fixed', 'phone_per_minute', 'scheduled_appointment']),
    title: z.string().min(3).max(120),
    description: z.string().max(400).optional().default(''),
    priceCents: z.number().int().min(100).max(100000),
    durationMinutes: z.number().int().min(15).max(180).nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Paramètres de prestation invalides' });
    return;
  }
  const ts = nowIso();
  const id = uuid();
  db.prepare(`
    INSERT INTO expert_services (id, expert_id, service_type, title, description, price_cents, currency, duration_minutes, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, 1, ?, ?)
  `).run(id, expert.id, parsed.data.serviceType, parsed.data.title.trim(), parsed.data.description.trim(), parsed.data.priceCents, parsed.data.durationMinutes ?? null, ts, ts);
  res.status(201).json({ ok: true, id });
});

expertRouter.patch('/services/:id', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Profil de conseiller introuvable' });
    return;
  }
  const schema = z.object({
    title: z.string().min(3).max(120).optional(),
    priceCents: z.number().int().min(100).max(100000).optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Mise à jour de prestation invalide' });
    return;
  }
  const svc = db.prepare('SELECT * FROM expert_services WHERE id = ? AND expert_id = ?').get(req.params.id, expert.id) as
    | { title: string; price_cents: number; is_active: number }
    | undefined;
  if (!svc) {
    res.status(404).json({ error: 'Prestation introuvable' });
    return;
  }
  db.prepare('UPDATE expert_services SET title = ?, price_cents = ?, is_active = ?, updated_at = ? WHERE id = ?')
    .run(
      parsed.data.title ?? svc.title,
      parsed.data.priceCents ?? svc.price_cents,
      parsed.data.isActive !== undefined ? (parsed.data.isActive ? 1 : 0) : svc.is_active,
      nowIso(),
      req.params.id
    );
  res.json({ ok: true });
});

expertRouter.put('/availability', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Expert profile not found' });
    return;
  }
  const schema = z.object({
    slots: z.array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        isBreak: z.boolean().default(false),
        timezone: z.string().default('Europe/Paris'),
      })
    ),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid schedule slots format' });
    return;
  }
  const ts = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM expert_availability WHERE expert_id = ?').run(expert.id);
    const ins = db.prepare('INSERT INTO expert_availability (id, expert_id, day_of_week, start_time, end_time, is_break, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of parsed.data.slots) {
      if (s.startTime < s.endTime) {
        ins.run(uuid(), expert.id, s.dayOfWeek, s.startTime, s.endTime, s.isBreak ? 1 : 0, s.timezone, ts);
      }
    }
  })();
  res.json({ ok: true });
});

expertRouter.get('/consultations', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Expert profile not found' });
    return;
  }
  const consultations = db
    .prepare(`
      SELECT c.*, cp.first_name || ' ' || cp.last_name as client_name, es.title as service_title
      FROM consultations c
      JOIN client_profiles cp ON cp.user_id = c.client_id
      JOIN expert_services es ON es.id = c.service_id
      WHERE c.expert_id = ?
      ORDER BY c.created_at DESC
    `)
    .all(expert.id);
  res.json({ consultations });
});

expertRouter.post('/consultations/:id/complete', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Expert profile not found' });
    return;
  }
  const c = db.prepare('SELECT id, expert_id FROM consultations WHERE id = ? AND expert_id = ?').get(req.params.id, expert.id) as
    | { id: string }
    | undefined;
  if (!c) {
    res.status(404).json({ error: 'Consultation not found' });
    return;
  }
  const finalized = finalizeConsultationAtomic(c.id);
  db.prepare("UPDATE chat_conversations SET status = 'closed' WHERE consultation_id = ?").run(c.id);
  res.json({ consultation: finalized });
});

// Expert Messaging
expertRouter.get('/conversations', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Expert profile not found' });
    return;
  }
  const rows = db
    .prepare(`
      SELECT conv.*, cp.first_name || ' ' || cp.last_name as client_name,
        c.billing_model, c.unit_price_cents, c.status as consultation_status, c.gross_amount_cents, c.units_consumed,
        (SELECT content FROM chat_messages m WHERE m.conversation_id = conv.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = conv.id AND m.sender_id != ? AND m.is_read = 0) as unread_count
      FROM chat_conversations conv
      JOIN client_profiles cp ON cp.user_id = conv.client_id
      LEFT JOIN consultations c ON c.id = conv.consultation_id
      WHERE conv.expert_id = ?
      ORDER BY COALESCE(conv.last_message_at, conv.created_at) DESC
    `)
    .all(req.authUser!.id, expert.id);
  res.json({ conversations: rows });
});

expertRouter.get('/conversations/:id/messages', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Expert profile not found' });
    return;
  }
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id = ? AND expert_id = ?').get(req.params.id, expert.id);
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
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

expertRouter.post('/conversations/:id/messages', (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content || content.length > 4000) {
    res.status(400).json({ error: 'Message must be 1 to 4000 characters' });
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

expertRouter.get('/earnings', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Expert profile not found' });
    return;
  }
  const earnings = db
    .prepare(`
      SELECT ee.*, c.service_type, c.created_at as consultation_date
      FROM expert_earnings ee
      JOIN consultations c ON c.id = ee.consultation_id
      WHERE ee.expert_id = ?
      ORDER BY ee.created_at DESC
    `)
    .all(expert.id);
  const withdrawals = db.prepare('SELECT * FROM withdrawals WHERE expert_id = ? ORDER BY created_at DESC').all(expert.id);
  res.json({ earnings, withdrawals });
});

expertRouter.post('/withdrawals', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Profil de conseiller introuvable' });
    return;
  }
  const schema = z.object({
    amountCents: z.number().int().min(1000),
    payoutMethod: z.string().min(3).max(120),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Retrait minimum de 10,00 € avec une méthode de versement valide' });
    return;
  }

  const totalEarned = (
    db.prepare("SELECT COALESCE(SUM(net_cents), 0) as t FROM expert_earnings WHERE expert_id = ? AND status = 'available'").get(expert.id) as {
      t: number;
    }
  ).t;
  const totalWithdrawn = (
    db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as t FROM withdrawals WHERE expert_id = ? AND status IN ('pending', 'approved', 'paid')").get(expert.id) as {
      t: number;
    }
  ).t;
  const availableToWithdraw = totalEarned - totalWithdrawn;

  if (parsed.data.amountCents > availableToWithdraw) {
    res.status(400).json({ error: `Le montant demandé dépasse le solde retirable (${(availableToWithdraw / 100).toFixed(2)} €).` });
    return;
  }

  const ts = nowIso();
  const id = uuid();
  db.prepare('INSERT INTO withdrawals (id, expert_id, amount_cents, payout_method, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, expert.id, parsed.data.amountCents, parsed.data.payoutMethod.trim(), 'pending', ts, ts);
  writeAuditLog({ actorId: req.authUser!.id, action: 'expert.withdrawal_requested', entityType: 'withdrawal', entityId: id, details: { amountCents: parsed.data.amountCents } });
  res.status(201).json({ ok: true, withdrawalId: id });
});

expertRouter.post('/reviews/:id/reply', (req, res) => {
  const expert = getExpertProfileForRequest(req.authUser!.id);
  if (!expert) {
    res.status(404).json({ error: 'Profil de conseiller introuvable' });
    return;
  }
  const reply = typeof req.body?.reply === 'string' ? req.body.reply.trim() : '';
  if (reply.length < 2 || reply.length > 1000) {
    res.status(400).json({ error: 'La réponse doit contenir entre 2 et 1000 caractères' });
    return;
  }
  const rev = db.prepare('SELECT id FROM reviews WHERE id = ? AND expert_id = ?').get(req.params.id, expert.id);
  if (!rev) {
    res.status(404).json({ error: 'Avis introuvable' });
    return;
  }
  db.prepare('UPDATE reviews SET expert_reply = ?, updated_at = ? WHERE id = ?').run(reply, nowIso(), req.params.id);
  res.json({ ok: true });
});
