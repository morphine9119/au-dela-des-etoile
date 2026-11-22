import { isProduction } from '../env.ts';
import { Router } from '../http/express-lite.ts';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  clearSessionCookie,
  hashPassword,
  loadAuthUser,
  rateLimit,
  requireAuth,
  setSessionCookie,
  signSessionToken,
  verifyPassword,
  writeAuditLog,
} from '../auth.ts';
import { db, nowIso, uuid } from '../db.ts';
import { awardLoyaltyPointsAtomic } from '../services/finance.ts';

export const authRouter = Router();
const authRateLimit = rateLimit(process.env.VITEST === 'true' ? 1000 : 25, 60000);

const registerSchema = z.object({
  email: z.string().email('Adresse e-mail invalide').max(180),
  password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères').max(128),
  firstName: z.string().min(1, 'Le prénom est requis').max(80),
  lastName: z.string().min(1, 'Le nom est requis').max(80),
  phone: z.string().trim().min(6, 'Le numéro de téléphone doit contenir au moins 6 caractères').max(40),
  preferredLanguage: z.enum(['en', 'fr', 'ar']).optional().default('fr'),
  timezone: z.string().max(64).optional().default('Europe/Paris'),
  referralCode: z.string().max(40).optional(),
  termsAccepted: z.boolean().default(false).refine(
    (accepted) => accepted === true,
    'Vous devez accepter les Conditions Générales et la Politique de Confidentialité.'
  ),
  marketingConsent: z.boolean().optional().default(false),
});

authRouter.post('/register', authRateLimit, (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Données d’inscription invalides' });
    return;
  }

  const email = parsed.data.email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    res.status(409).json({ error: 'Un compte existe déjà avec cette adresse e-mail.' });
    return;
  }

  const ts = nowIso();
  const userId = uuid();
  const passHash = hashPassword(parsed.data.password);
  const myReferralCode = `${parsed.data.firstName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'ASTRAL'}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  const createTx = db.transaction(() => {
    db.prepare('INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)')
      .run(userId, email, passHash, 'active', ts, ts);
    db.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(uuid(), userId, 'client', ts);
    db.prepare('INSERT INTO client_profiles (user_id, first_name, last_name, phone, preferred_language, timezone, marketing_consent, terms_accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        userId,
        parsed.data.firstName.trim(),
        parsed.data.lastName.trim(),
        parsed.data.phone,
        'fr',
        parsed.data.timezone,
        parsed.data.marketingConsent ? 1 : 0,
        parsed.data.termsAccepted ? ts : null,
        ts,
        ts
      );
    db.prepare('INSERT INTO wallets (user_id, available_cents, pending_cents, currency, updated_at) VALUES (?, 0, 0, ?, ?)')
      .run(userId, 'EUR', ts);
    db.prepare('INSERT INTO loyalty_accounts (user_id, points_balance, lifetime_points, tier, referral_code, updated_at) VALUES (?, 0, 0, ?, ?, ?)')
      .run(userId, 'silver', myReferralCode, ts);
    db.prepare('INSERT INTO notification_preferences (user_id, email_bookings, email_messages, email_promotions, in_app_all) VALUES (?, 1, 1, ?, 1)')
      .run(userId, parsed.data.marketingConsent ? 1 : 0);

    // Prime de bienvenue (100 points)
    awardLoyaltyPointsAtomic({
      userId,
      points: 100,
      type: 'registration',
      description: 'Prime de bienvenue lors de l’inscription',
    });

    if (parsed.data.referralCode) {
      const refOwner = db
        .prepare('SELECT user_id FROM loyalty_accounts WHERE referral_code = ?')
        .get(parsed.data.referralCode.trim().toUpperCase()) as { user_id: string } | undefined;
      if (refOwner && refOwner.user_id !== userId) {
        awardLoyaltyPointsAtomic({
          userId: refOwner.user_id,
          points: 200,
          type: 'referral',
          referenceId: userId,
          description: 'Bonus de parrainage pour un nouveau membre',
        });
        awardLoyaltyPointsAtomic({
          userId,
          points: 100,
          type: 'referral',
          referenceId: refOwner.user_id,
          description: 'Bonus de bienvenue parrainé',
        });
      }
    }
  });

  createTx();
  writeAuditLog({ actorId: userId, action: 'user.registered', entityType: 'user', entityId: userId, ipAddress: req.ip });

  const token = signSessionToken(userId);
  setSessionCookie(res, token, req);
  const authUser = loadAuthUser(userId);
  res.status(201).json({ user: authUser, token });
});

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Le nom d’utilisateur ou l’adresse e-mail est requis').max(180),
  password: z.string().min(1, 'Le mot de passe est requis'),
});

authRouter.post('/login', authRateLimit, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Veuillez saisir une adresse e-mail et un mot de passe valides.' });
    return;
  }

  const identifier = parsed.data.email.trim().toLowerCase();
  const email = identifier === 'admin' ? 'admin@maison-astralis.local' : identifier;
  const userRow = db
    .prepare('SELECT id, password_hash, status, deleted_at, is_demo FROM users WHERE email = ?')
    .get(email) as { id: string; password_hash: string; status: string; deleted_at: string | null; is_demo: number } | undefined;

  if (
    !userRow ||
    userRow.deleted_at ||
    (isProduction() && userRow.is_demo) ||
    !verifyPassword(parsed.data.password, userRow.password_hash)
  ) {
    res.status(401).json({ error: 'Adresse e-mail ou mot de passe incorrect.' });
    return;
  }

  if (userRow.status === 'suspended') {
    res.status(403).json({ error: 'Votre compte a été suspendu. Veuillez contacter le support.' });
    return;
  }
  if (userRow.status !== 'active') {
    res.status(403).json({ error: 'Ce compte est désactivé ou clôturé.' });
    return;
  }

  const token = signSessionToken(userRow.id);
  setSessionCookie(res, token, req);
  writeAuditLog({ actorId: userRow.id, action: 'user.login', entityType: 'user', entityId: userRow.id, ipAddress: req.ip });

  const authUser = loadAuthUser(userRow.id);
  res.json({ user: authUser, token });
});

authRouter.post('/logout', (req, res) => {
  clearSessionCookie(res, req);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.authUser) {
    res.json({ user: null });
    return;
  }
  const profile = db
    .prepare('SELECT first_name, last_name, phone, phone_verified, avatar_url, preferred_language, timezone, marketing_consent FROM client_profiles WHERE user_id = ?')
    .get(req.authUser.id);
  const wallet = db.prepare('SELECT available_cents, pending_cents, currency FROM wallets WHERE user_id = ?').get(req.authUser.id);
  const loyalty = db.prepare('SELECT points_balance, lifetime_points, tier, referral_code FROM loyalty_accounts WHERE user_id = ?').get(req.authUser.id);

  res.json({
    user: {
      ...req.authUser,
      profile,
      wallet,
      loyalty,
    },
  });
});

authRouter.post('/forgot-password', rateLimit(10, 60000), (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const user = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email) as { id: string } | undefined;
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 3600000).toISOString();
    db.prepare('INSERT INTO password_resets (id, user_id, token, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(uuid(), user.id, token, expires, nowIso());
    writeAuditLog({ actorId: user.id, action: 'user.password_reset_requested', entityType: 'user', entityId: user.id });
  }

  // Always return neutral confirmation to prevent email enumeration
  res.json({
    message: 'If an account matches that email address, password reset instructions have been queued.',
  });
});

authRouter.post('/reset-password', (req, res) => {
  const schema = z.object({ token: z.string().min(10), newPassword: z.string().min(8).max(128) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid token and password (min 8 chars) required' });
    return;
  }

  const row = db
    .prepare('SELECT * FROM password_resets WHERE token = ? AND used = 0')
    .get(parsed.data.token) as { id: string; user_id: string; expires_at: string } | undefined;

  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: 'Reset token is invalid or expired' });
    return;
  }

  const hash = hashPassword(parsed.data.newPassword);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, nowIso(), row.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
  })();

  res.json({ ok: true });
});

authRouter.post('/deactivate', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  db.prepare("UPDATE users SET status = 'deactivated', updated_at = ? WHERE id = ?").run(nowIso(), userId);
  writeAuditLog({ actorId: userId, action: 'user.deactivated', entityType: 'user', entityId: userId });
  clearSessionCookie(res, req);
  res.json({ ok: true });
});

authRouter.post('/delete-request', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const ts = nowIso();
  db.prepare("UPDATE users SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, userId);
  writeAuditLog({ actorId: userId, action: 'user.deleted', entityType: 'user', entityId: userId });
  clearSessionCookie(res, req);
  res.json({ ok: true });
});

authRouter.get('/export-data', requireAuth, (req, res) => {
  const userId = req.authUser!.id;
  const user = db.prepare('SELECT id, email, status, created_at FROM users WHERE id = ?').get(userId);
  const profile = db.prepare('SELECT * FROM client_profiles WHERE user_id = ?').get(userId);
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  const transactions = db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  const consultations = db.prepare('SELECT * FROM consultations WHERE client_id = ? ORDER BY created_at DESC').all(userId);
  const appointments = db.prepare('SELECT * FROM appointments WHERE client_id = ? ORDER BY scheduled_start DESC').all(userId);

  writeAuditLog({ actorId: userId, action: 'user.gdpr_export', entityType: 'user', entityId: userId });
  res.json({ exportedAt: nowIso(), user, profile, wallet, transactions, consultations, appointments });
});
