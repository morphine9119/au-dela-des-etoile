import { appEnv, isProduction } from './env.ts';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { SqlDriver, SqlValue } from './sql-driver.ts';

/**
 * better-sqlite3-compatible facade over a synchronous SqlDriver.
 * The driver is bound once at startup (Durable Object storage on Cloudflare,
 * node:sqlite in tests) so the rest of the server code can keep using
 * `db.prepare(...).get/all/run`, `db.transaction(fn)`, `db.exec`, `db.pragma`.
 */
let driver: SqlDriver | null = null;

export function bindDatabase(next: SqlDriver): void {
  driver = next;
}

function d(): SqlDriver {
  if (!driver) throw new Error('Database is not initialised.');
  return driver;
}

function normalise(params: unknown[]): SqlValue[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
  return flat.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as SqlValue)));
}

export interface RunResult {
  changes: number;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export const db = {
  prepare(sql: string): Statement {
    return {
      run(...params) {
        const drv = d();
        drv.query(sql, normalise(params));
        const changes = Number(drv.query('SELECT changes() AS c', [])[0]?.c ?? 0);
        return { changes };
      },
      get(...params) {
        return d().query(sql, normalise(params))[0];
      },
      all(...params) {
        return d().query(sql, normalise(params));
      },
    };
  },
  exec(sql: string): void {
    d().exec(sql);
  },
  pragma(statement: string): unknown {
    const name = statement.split(/[\s(=]/)[0].toLowerCase();
    // Read-only introspection pragmas work everywhere.
    if (name === 'table_info' || name === 'foreign_key_list' || name === 'table_list') {
      return d().query(`PRAGMA ${statement}`, []);
    }
    // defer_foreign_keys is supported inside transactions on every driver.
    if (name === 'defer_foreign_keys') {
      d().exec(`PRAGMA ${statement}`);
      return [];
    }
    // journal_mode / foreign_keys are managed by the platform (Durable Objects
    // keep foreign keys enforced and manage the journal themselves).
    return [];
  },
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => d().transaction(() => fn(...args));
  },
  close(): void {
    driver?.close?.();
    driver = null;
  },
};

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated', 'deleted')),
      email_verified INTEGER NOT NULL DEFAULT 0,
      two_factor_enabled INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('client', 'expert', 'admin', 'staff')),
      created_at TEXT NOT NULL,
      UNIQUE(user_id, role)
    );

    CREATE TABLE IF NOT EXISTS client_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      avatar_url TEXT,
      preferred_language TEXT NOT NULL DEFAULT 'en',
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      marketing_consent INTEGER NOT NULL DEFAULT 0,
      terms_accepted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expert_categories (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name_en TEXT NOT NULL,
      name_fr TEXT NOT NULL,
      name_ar TEXT NOT NULL,
      description_en TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expert_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      headline TEXT NOT NULL,
      specialty TEXT NOT NULL,
      category_slug TEXT NOT NULL REFERENCES expert_categories(slug),
      biography TEXT NOT NULL,
      years_experience INTEGER NOT NULL DEFAULT 1,
      languages_json TEXT NOT NULL DEFAULT '["en","fr"]',
      tools_json TEXT NOT NULL DEFAULT '[]',
      avatar_url TEXT,
      cover_url TEXT,
      intro_video_url TEXT,
      external_chat_url TEXT,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_featured INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended', 'rejected')),
      presence_status TEXT NOT NULL DEFAULT 'offline' CHECK (presence_status IN ('online', 'busy', 'offline')),
      rating_avg_bp INTEGER NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      rating_override_bp INTEGER CHECK (rating_override_bp BETWEEN 0 AND 500),
      review_count_override INTEGER CHECK (review_count_override >= 0),
      completed_consultations INTEGER NOT NULL DEFAULT 0,
      custom_commission_bp INTEGER,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expert_services (
      id TEXT PRIMARY KEY,
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id) ON DELETE CASCADE,
      service_type TEXT NOT NULL CHECK (service_type IN ('chat_per_message', 'chat_per_minute', 'chat_fixed', 'phone_per_minute', 'scheduled_appointment')),
      title TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      duration_minutes INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expert_availability (
      id TEXT PRIMARY KEY,
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_break INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expert_applications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      full_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      country TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      specialties_json TEXT NOT NULL,
      years_experience INTEGER NOT NULL,
      biography TEXT NOT NULL,
      methods_json TEXT NOT NULL,
      portfolio_url TEXT,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft', 'submitted', 'under_review', 'interview', 'approved', 'rejected', 'activated')),
      internal_notes TEXT,
      reviewed_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consultations (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id),
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id),
      service_id TEXT NOT NULL REFERENCES expert_services(id),
      service_type TEXT NOT NULL,
      billing_model TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'cancelled', 'disputed')),
      units_consumed INTEGER NOT NULL DEFAULT 0,
      gross_amount_cents INTEGER NOT NULL DEFAULT 0,
      commission_bp INTEGER NOT NULL DEFAULT 2500,
      commission_cents INTEGER NOT NULL DEFAULT 0,
      expert_net_cents INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      ended_at TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_conversations (
      id TEXT PRIMARY KEY,
      consultation_id TEXT REFERENCES consultations(id) ON DELETE SET NULL,
      client_id TEXT NOT NULL REFERENCES users(id),
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
      last_message_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      attachment_url TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      billed_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_sessions (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_call_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('requested', 'provider_unconfigured', 'ringing', 'in_progress', 'completed', 'failed')),
      consent_recorded INTEGER NOT NULL DEFAULT 0,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id),
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id),
      service_id TEXT NOT NULL REFERENCES expert_services(id),
      scheduled_start TEXT NOT NULL,
      scheduled_end TEXT NOT NULL,
      client_timezone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'completed', 'cancelled', 'rescheduled')),
      price_cents INTEGER NOT NULL,
      notes TEXT,
      cancellation_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      consultation_id TEXT UNIQUE NOT NULL REFERENCES consultations(id),
      client_id TEXT NOT NULL REFERENCES users(id),
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      expert_reply TEXT,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'flagged', 'removed')),
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(client_id, expert_id)
    );

    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      available_cents INTEGER NOT NULL DEFAULT 0 CHECK (available_cents >= 0),
      pending_cents INTEGER NOT NULL DEFAULT 0 CHECK (pending_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider TEXT NOT NULL,
      provider_intent_id TEXT,
      idempotency_key TEXT UNIQUE NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'failed', 'refunded', 'sandbox_test')),
      country_code TEXT NOT NULL DEFAULT 'FR',
      is_sandbox INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'refund', 'adjustment', 'hold', 'release')),
      amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      description TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      payment_id TEXT REFERENCES payments(id),
      consultation_id TEXT REFERENCES consultations(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'processed')),
      reviewed_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commission_rules (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'expert', 'service_type', 'promotional')),
      target_id TEXT,
      rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
      description TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expert_earnings (
      id TEXT PRIMARY KEY,
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id),
      consultation_id TEXT UNIQUE NOT NULL REFERENCES consultations(id),
      gross_cents INTEGER NOT NULL,
      commission_cents INTEGER NOT NULL,
      net_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('pending', 'available', 'withdrawn', 'reversed')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      expert_id TEXT NOT NULL REFERENCES expert_profiles(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      payout_method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
      reviewed_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loyalty_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
      lifetime_points INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'silver' CHECK (tier IN ('silver', 'gold', 'celestial')),
      referral_code TEXT UNIQUE NOT NULL,
      last_daily_claim_date TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      points_delta INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('registration', 'purchase', 'daily_claim', 'referral', 'redemption', 'expiration', 'admin_adjustment')),
      reference_id TEXT,
      description TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reward_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      points_multiplier_bp INTEGER NOT NULL DEFAULT 10000,
      bonus_points INTEGER NOT NULL DEFAULT 0,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('fixed_cents', 'percent_bp')),
      discount_value INTEGER NOT NULL,
      points_cost INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id TEXT PRIMARY KEY,
      coupon_id TEXT NOT NULL REFERENCES coupons(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      consultation_id TEXT REFERENCES consultations(id),
      created_at TEXT NOT NULL,
      UNIQUE(coupon_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link_url TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      email_bookings INTEGER NOT NULL DEFAULT 1,
      email_messages INTEGER NOT NULL DEFAULT 1,
      email_promotions INTEGER NOT NULL DEFAULT 0,
      in_app_all INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS article_categories (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      category_slug TEXT NOT NULL REFERENCES article_categories(slug),
      author_name TEXT NOT NULL,
      title TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content TEXT NOT NULL,
      cover_url TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      seo_title TEXT,
      seo_description TEXT,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
      published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS horoscopes (
      id TEXT PRIMARY KEY,
      sign TEXT NOT NULL,
      period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly', 'yearly')),
      period_key TEXT NOT NULL,
      overview TEXT NOT NULL,
      love_guidance TEXT NOT NULL,
      career_guidance TEXT NOT NULL,
      lucky_number INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(sign, period, period_key)
    );

    CREATE TABLE IF NOT EXISTS tarot_cards (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      arcana TEXT NOT NULL,
      element TEXT NOT NULL,
      upright_meaning TEXT NOT NULL,
      reversed_meaning TEXT NOT NULL,
      guidance TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS faqs (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_published INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      category TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'closed')),
      subject TEXT NOT NULL,
      internal_notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      is_staff INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 1,
      email_delivery_status TEXT NOT NULL DEFAULT 'sent',
      email_error TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uploaded_files (
      filename TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS newsletter_subscribers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_messages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      user_id TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS contact_message_replies (
      id TEXT PRIMARY KEY,
      contact_message_id TEXT NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      is_staff INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      email_delivery_status TEXT NOT NULL DEFAULT 'sent',
      email_error TEXT
    );

    CREATE TABLE IF NOT EXISTS abuse_reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id),
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_experts_status ON expert_profiles(status, category_slug);
    CREATE INDEX IF NOT EXISTS idx_consultations_client ON consultations(client_id, status);
    CREATE INDEX IF NOT EXISTS idx_consultations_expert ON consultations(expert_id, status);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON chat_messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_appointments_expert ON appointments(expert_id, scheduled_start);
    CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
  `);

  const expertProfileColumns = db.pragma('table_info(expert_profiles)') as Array<{ name: string }>;
  if (!expertProfileColumns.some((column) => column.name === 'external_chat_url')) {
    db.exec('ALTER TABLE expert_profiles ADD COLUMN external_chat_url TEXT');
  }
  if (!expertProfileColumns.some((column) => column.name === 'rating_override_bp')) {
    db.exec('ALTER TABLE expert_profiles ADD COLUMN rating_override_bp INTEGER CHECK (rating_override_bp BETWEEN 0 AND 500)');
  }
  if (!expertProfileColumns.some((column) => column.name === 'review_count_override')) {
    db.exec('ALTER TABLE expert_profiles ADD COLUMN review_count_override INTEGER CHECK (review_count_override >= 0)');
  }
  const clientProfileColumns = db.pragma('table_info(client_profiles)') as Array<{ name: string }>;
  if (!clientProfileColumns.some((column) => column.name === 'terms_accepted_at')) {
    db.exec('ALTER TABLE client_profiles ADD COLUMN terms_accepted_at TEXT');
  }
  const supportTicketColumns = db.pragma('table_info(support_tickets)') as Array<{ name: string }>;
  if (!supportTicketColumns.some((column) => column.name === 'archived_at')) {
    db.exec('ALTER TABLE support_tickets ADD COLUMN archived_at TEXT');
  }
  const supportMessageColumns = db.pragma('table_info(support_messages)') as Array<{ name: string }>;
  if (!supportMessageColumns.some((column) => column.name === 'is_read')) {
    db.exec('ALTER TABLE support_messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 1');
  }
  if (!supportMessageColumns.some((column) => column.name === 'email_delivery_status')) {
    db.exec("ALTER TABLE support_messages ADD COLUMN email_delivery_status TEXT NOT NULL DEFAULT 'sent'");
  }
  if (!supportMessageColumns.some((column) => column.name === 'email_error')) {
    db.exec('ALTER TABLE support_messages ADD COLUMN email_error TEXT');
  }
  const contactMessageColumns = db.pragma('table_info(contact_messages)') as Array<{ name: string }>;
  if (!contactMessageColumns.some((column) => column.name === 'archived_at')) {
    db.exec('ALTER TABLE contact_messages ADD COLUMN archived_at TEXT');
  }
  if (!contactMessageColumns.some((column) => column.name === 'is_read')) {
    db.exec('ALTER TABLE contact_messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0');
  }
  if (!contactMessageColumns.some((column) => column.name === 'user_id')) {
    db.exec('ALTER TABLE contact_messages ADD COLUMN user_id TEXT REFERENCES users(id)');
  }
  if (!contactMessageColumns.some((column) => column.name === 'updated_at')) {
    db.exec('ALTER TABLE contact_messages ADD COLUMN updated_at TEXT');
  }
  db.prepare('UPDATE contact_messages SET updated_at = created_at WHERE updated_at IS NULL').run();
  const contactReplyColumns = db.pragma('table_info(contact_message_replies)') as Array<{ name: string }>;
  if (!contactReplyColumns.some((column) => column.name === 'is_staff')) {
    db.exec('ALTER TABLE contact_message_replies ADD COLUMN is_staff INTEGER NOT NULL DEFAULT 1');
  }
  if (!contactReplyColumns.some((column) => column.name === 'is_read')) {
    db.exec('ALTER TABLE contact_message_replies ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_read
      ON support_messages(ticket_id, is_staff, is_read, created_at);
    CREATE INDEX IF NOT EXISTS idx_contact_messages_archive
      ON contact_messages(archived_at, status, is_read);
    CREATE INDEX IF NOT EXISTS idx_contact_messages_user
      ON contact_messages(user_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_archive
      ON support_tickets(archived_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_contact_replies_ticket
      ON contact_message_replies(contact_message_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_contact_replies_read
      ON contact_message_replies(contact_message_id, is_staff, is_read);
  `);

  const ts = nowIso();
  const ensureSetting = db.prepare('INSERT OR IGNORE INTO platform_settings (key, value_json, updated_at) VALUES (?, ?, ?)');
  ensureSetting.run('main_number', JSON.stringify('+33123456789'), ts);
  ensureSetting.run('free_offer_enabled', JSON.stringify(true), ts);
  ensureSetting.run('default_language', JSON.stringify('fr'), ts);

  seedDemoDataIfEmpty();
  if (isProduction()) {
    disableDemoAccounts();
  } else {
    restoreDevelopmentDemoAccounts();
    if (appEnv() !== 'test') {
      retireDevelopmentDemoAdmin();
    }
  }
  ensureConfiguredProductionAdmin();
  updateStoredBrandName();
}

function ensureConfiguredProductionAdmin(): void {
  if (!isProduction()) return;

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set together in production.');
  }
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters in production.');
  }

  const firstName = process.env.ADMIN_FIRST_NAME?.trim() || 'Admin';
  const lastName = process.env.ADMIN_LAST_NAME?.trim() || 'Astralis';
  const ts = nowIso();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
  const passwordHash = bcrypt.hashSync(password, 12);

  db.transaction(() => {
    const userId = existing?.id || uuid();
    if (existing) {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, status = 'active', email_verified = 1, is_demo = 0, deleted_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(passwordHash, ts, userId);
    } else {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 1, 0, ?, ?)
      `).run(userId, email, passwordHash, ts, ts);
    }

    db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(uuid(), userId, 'admin', ts);
    db.prepare(`
      INSERT INTO client_profiles (user_id, first_name, last_name, phone, preferred_language, timezone, marketing_consent, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'fr', 'Europe/Paris', 0, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, updated_at = excluded.updated_at
    `).run(userId, firstName, lastName, ts, ts);
    db.prepare('INSERT OR IGNORE INTO wallets (user_id, available_cents, pending_cents, currency, updated_at) VALUES (?, 0, 0, ?, ?)')
      .run(userId, 'EUR', ts);
    db.prepare('INSERT OR IGNORE INTO notification_preferences (user_id, email_bookings, email_messages, email_promotions, in_app_all) VALUES (?, 1, 1, 0, 1)')
      .run(userId);
  })();
}

function restoreDevelopmentDemoAccounts(): void {
  const ts = nowIso();
  const legacyAdmin = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.demo' AND is_demo = 1").get() as { id: string } | undefined;
  if (legacyAdmin) {
    db.prepare("UPDATE users SET email = 'admin@gmail.com', password_hash = ?, status = 'active', deleted_at = NULL, updated_at = ? WHERE id = ?")
      .run(bcrypt.hashSync('admin1122', 10), ts, legacyAdmin.id);
  }

  const accounts = [
    { email: 'claire@maison-astralis.demo', password: 'AstralisClient2026!', presence: null },
    { email: 'julien@maison-astralis.demo', password: 'AstralisClient2026!', presence: null },
    { email: 'celeste@maison-astralis.demo', password: 'AstralisExpert2026!', presence: 'online' },
    { email: 'marcus@maison-astralis.demo', password: 'AstralisExpert2026!', presence: 'online' },
    { email: 'nadia@maison-astralis.demo', password: 'AstralisExpert2026!', presence: 'online' },
    { email: 'soraya@maison-astralis.demo', password: 'AstralisExpert2026!', presence: 'online' },
    { email: 'henri@maison-astralis.demo', password: 'AstralisExpert2026!', presence: 'offline' },
    { email: 'elena@maison-astralis.demo', password: 'AstralisExpert2026!', presence: 'online' },
  ] as const;
  const findUser = db.prepare('SELECT id, status, deleted_at FROM users WHERE email = ? AND is_demo = 1');
  const updateUser = db.prepare('UPDATE users SET password_hash = ?, status = ?, deleted_at = NULL, updated_at = ? WHERE id = ?');
  const restoreExpert = db.prepare(`
    UPDATE expert_profiles
    SET status = 'approved', presence_status = ?, updated_at = ?
    WHERE user_id = ? AND is_demo = 1
  `);

  db.transaction(() => {
    for (const account of accounts) {
      const user = findUser.get(account.email) as
        | { id: string; status: string; deleted_at: string | null }
        | undefined;
      if (!user) continue;

      const wasDeleted = user.status === 'deleted' || user.deleted_at !== null;
      const status = wasDeleted ? 'active' : user.status;
      updateUser.run(bcrypt.hashSync(account.password, 10), status, ts, user.id);
      if (wasDeleted && account.presence) {
        restoreExpert.run(account.presence, ts, user.id);
      }
    }
  })();
}

function retireDevelopmentDemoAdmin(): void {
  const ts = nowIso();
  db.prepare(`
    UPDATE users
    SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
    WHERE email = 'admin@maison-astralis.demo' AND is_demo = 1 AND deleted_at IS NULL
  `).run(ts, ts);
}

function disableDemoAccounts(): void {
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
      WHERE is_demo = 1 AND deleted_at IS NULL
    `).run(ts, ts);
    db.prepare(`
      UPDATE expert_profiles
      SET status = 'suspended', presence_status = 'offline', updated_at = ?
      WHERE is_demo = 1
    `).run(ts);
  })();
}

function updateStoredBrandName(): void {
  const oldName = 'Maison Astralis';
  const newName = 'Au-delà des Étoiles';
  const ts = nowIso();
  db.prepare('UPDATE platform_settings SET value_json = REPLACE(value_json, ?, ?), updated_at = ? WHERE value_json LIKE ?')
    .run(oldName, newName, ts, `%${oldName}%`);
  db.prepare('UPDATE commission_rules SET description = REPLACE(description, ?, ?) WHERE description LIKE ?')
    .run(oldName, newName, `%${oldName}%`);
  db.prepare('UPDATE notifications SET body = REPLACE(body, ?, ?) WHERE body LIKE ?')
    .run(oldName, newName, `%${oldName}%`);
  db.prepare('UPDATE articles SET seo_title = REPLACE(seo_title, ?, ?) WHERE seo_title LIKE ?')
    .run(oldName, newName, `%${oldName}%`);
}

function seedDemoDataIfEmpty(): void {
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (existingUsers.count > 0) return;

  const ts = nowIso();
  const adminPass = bcrypt.hashSync('admin1122', 10);
  const expertPass = bcrypt.hashSync('AstralisExpert2026!', 10);
  const clientPass = bcrypt.hashSync('AstralisClient2026!', 10);

  const seedTx = db.transaction(() => {
    // Platform Settings
    const settings: Array<[string, unknown]> = [
      ['brand_name', 'Au-delà des Étoiles'],
      ['main_number', '+33123456789'],
      ['free_offer_enabled', true],
      ['default_currency', 'EUR'],
      ['default_language', 'fr'],
      ['tax_rate_bp', 2000],
      ['points_per_euro', 10],
      ['points_redemption_rate_cents', 1],
      ['points_expiration_days', 365],
      ['maintenance_mode', false],
      ['homepage_banner', {
        active: true,
        text: 'Offre Découverte — Première consultation offerte à 0,00 € avec tous nos conseillers.',
        ctaLabel: 'Découvrir les conseillers',
        ctaHref: '/experts'
      }],
    ];
    const insertSetting = db.prepare('INSERT OR IGNORE INTO platform_settings (key, value_json, updated_at) VALUES (?, ?, ?)');
    for (const [k, v] of settings) {
      insertSetting.run(k, JSON.stringify(v), ts);
    }

    // Global & Service Commission Rules
    db.prepare('INSERT INTO commission_rules (id, scope, target_id, rate_bp, description, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuid(), 'global', null, 2500, 'Commission standard Au-delà des Étoiles (25 %)', 1, ts);
    db.prepare('INSERT INTO commission_rules (id, scope, target_id, rate_bp, description, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuid(), 'service_type', 'scheduled_appointment', 2000, 'Commission réduite pour rendez-vous programmés 45 min (20 %)', 1, ts);

    // Categories
    const categories = [
      ['astrology', 'Astrologie Natale', 'Astrologie Natale', 'علم التنجيم', 'Lecture du thème natal, transits planétaires et révolutions solaires.', 1],
      ['tarot', 'Tarot & Arcanes', 'Tarot & Arcanes', 'التاروت', 'Tirages archétypaux pour éclairer vos choix et transitions de vie.', 2],
      ['numerology', 'Numérologie', 'Numérologie', 'علم الأعداد', 'Chemin de vie, années personnelles et cycles de décision.', 3],
      ['mediumship', 'Guidance Intuitive', 'Guidance Intuitive', 'الإرشاد الحدسي', 'Écoute réflexive pour vos questions relationnelles et professionnelles.', 4],
      ['cartomancy', 'Cartomancie', 'Cartomancie', 'قراءة الأوراق', 'Tirages classiques français et Petit Lenormand pour des repères concrets.', 5],
    ] as const;

    const insCat = db.prepare('INSERT INTO expert_categories (id, slug, name_en, name_fr, name_ar, description_en, sort_order, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)');
    for (const [slug, en, fr, ar, desc, order] of categories) {
      insCat.run(uuid(), slug, en, fr, ar, desc, order, ts);
    }

    // Users
    const adminId = uuid();
    const client1Id = uuid();
    const client2Id = uuid();
    const exp1UserId = uuid();
    const exp2UserId = uuid();
    const exp3UserId = uuid();
    const exp4UserId = uuid();
    const exp5UserId = uuid();
    const exp6UserId = uuid();

    const insUser = db.prepare('INSERT INTO users (id, email, password_hash, status, email_verified, two_factor_enabled, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, 1, ?, ?)');
    const insRole = db.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)');
    const insClient = db.prepare('INSERT INTO client_profiles (user_id, first_name, last_name, phone, phone_verified, preferred_language, timezone, marketing_consent, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?)');
    const insWallet = db.prepare('INSERT INTO wallets (user_id, available_cents, pending_cents, currency, updated_at) VALUES (?, ?, 0, ?, ?)');
    const insLoyalty = db.prepare('INSERT INTO loyalty_accounts (user_id, points_balance, lifetime_points, tier, referral_code, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insNotifPref = db.prepare('INSERT INTO notification_preferences (user_id, email_bookings, email_messages, email_promotions, in_app_all) VALUES (?, 1, 1, 0, 1)');

    // Admin
    insUser.run(adminId, 'admin@gmail.com', adminPass, 'active', ts, ts);
    insRole.run(uuid(), adminId, 'admin', ts);
    insClient.run(adminId, 'Camille', 'Laurent', '+33600000001', 'en', 'Europe/Paris', ts, ts);
    insWallet.run(adminId, 0, 'EUR', ts);
    insNotifPref.run(adminId);

    // Demo Clients
    insUser.run(client1Id, 'claire@maison-astralis.demo', clientPass, 'active', ts, ts);
    insRole.run(uuid(), client1Id, 'client', ts);
    insClient.run(client1Id, 'Claire', 'Delacroix', '+33611223344', 'en', 'Europe/Paris', ts, ts);
    insWallet.run(client1Id, 14500, 'EUR', ts);
    insLoyalty.run(client1Id, 680, 1420, 'gold', 'CLAIRE-ASTRAL-26', ts);
    insNotifPref.run(client1Id);

    insUser.run(client2Id, 'julien@maison-astralis.demo', clientPass, 'active', ts, ts);
    insRole.run(uuid(), client2Id, 'client', ts);
    insClient.run(client2Id, 'Julien', 'Mercier', '+33622334455', 'fr', 'Europe/Paris', ts, ts);
    insWallet.run(client2Id, 6500, 'EUR', ts);
    insLoyalty.run(client2Id, 240, 240, 'silver', 'JULIEN-ASTRAL-26', ts);
    insNotifPref.run(client2Id);

    // Seed wallet transaction history for demo client 1
    db.prepare('INSERT INTO wallet_transactions (id, user_id, type, amount_cents, balance_after_cents, reference_type, reference_id, description, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuid(), client1Id, 'credit', 20000, 20000, 'demo_seed', 'seed-1', 'Demo sandbox wallet initial credit', 'seed-wallet-1', ts);
    db.prepare('INSERT INTO wallet_transactions (id, user_id, type, amount_cents, balance_after_cents, reference_type, reference_id, description, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuid(), client1Id, 'debit', -5500, 14500, 'consultation', 'seed-c-1', 'Consultation with Céleste Moreau (Tarot Synthesis)', 'seed-wallet-2', ts);

    // Experts
    const expertsData = [
      {
        userId: exp1UserId,
        email: 'celeste@maison-astralis.demo',
        firstName: 'Céleste',
        lastName: 'Moreau',
        slug: 'celeste-moreau',
        displayName: 'Céleste Moreau',
        headline: 'Astrologue Hellénistique & Spécialiste du Tarot de Marseille',
        specialty: 'Astrologie Natale & Tarot',
        category: 'astrology',
        bio: 'Formée aux techniques d’astrologie hellénistique classique et forte de vingt-deux ans de pratique du Tarot de Marseille à Lyon et Paris. Céleste structure chaque séance autour des cycles de vie concrets et d’une lecture symbolique rigoureuse.',
        years: 16,
        langs: ['fr'],
        tools: ['Éphémérides Natales', 'Tarot de Marseille', 'Révolution Solaire'],
        avatar: '/src/assets/images/expert_portrait_celeste_1794559554136.jpg',
        featured: 1,
        presence: 'online',
        ratingBp: 492,
        reviews: 128,
        completed: 412,
        services: [
          ['chat_per_message', 'Consultation Tchat par Message', 'Réponse écrite ciblée facturée au message.', 390, null],
          ['chat_per_minute', 'Dialogue Astrologique en Direct', 'Synthèse astrologique en temps réel par minute.', 280, null],
          ['scheduled_appointment', 'Lecture du Thème Natal (45 min)', 'Séance individuelle structurée avec préparation du thème.', 8500, 45],
          ['phone_per_minute', 'Consultation Téléphonique Directe', 'Entretien vocal direct facturé à la minute.', 320, null],
        ] as const,
      },
      {
        userId: exp2UserId,
        email: 'marcus@maison-astralis.demo',
        firstName: 'Marcus',
        lastName: 'Vance',
        slug: 'marcus-vance',
        displayName: 'Marcus Vance',
        headline: 'Numérologue Pythagoricien & Conseiller en Cycles Stratégiques',
        specialty: 'Numérologie Pythagoricienne',
        category: 'numerology',
        bio: 'Auteur et praticien spécialisé en numérologie pythagoricienne et cartographie des années personnelles. Marcus accompagne les transitions professionnelles et les décisions d’orientation.',
        years: 14,
        langs: ['fr'],
        tools: ['Matrice Pythagoricienne', 'Année Personnelle', 'Harmoniques'],
        avatar: '/src/assets/images/expert_portrait_marcus_1794559554785.jpg',
        featured: 0,
        presence: 'online',
        ratingBp: 486,
        reviews: 94,
        completed: 289,
        services: [
          ['chat_fixed', 'Bilan Écrit d’Année Personnelle', 'Synthèse numérologique complète à tarif fixe.', 4500, 30],
          ['chat_per_minute', 'Séance Tchat Numérologie', 'Échange en direct facturé à la minute.', 260, null],
          ['scheduled_appointment', 'Audit Carrière & Timing (60 min)', 'Planification annuelle approfondie.', 11000, 60],
        ] as const,
      },
      {
        userId: exp3UserId,
        email: 'nadia@maison-astralis.demo',
        firstName: 'Nadia',
        lastName: 'Mansour',
        slug: 'nadia-mansour',
        displayName: 'Nadia Mansour',
        headline: 'Conseillère Intuitive & Spécialiste du Tarot Relationnel',
        specialty: 'Guidance Intuitive & Tarot',
        category: 'tarot',
        bio: 'Praticienne entre Paris et Lyon, Nadia associe la symbolique classique du tarot à une écoute attentive pour éclairer les dynamiques relationnelles et les choix personnels.',
        years: 11,
        langs: ['fr'],
        tools: ['Tarot Rider-Waite', 'Tirage Miroir', 'Journal Lunaire'],
        avatar: '/src/assets/images/expert_portrait_nadia_1794559555197.jpg',
        featured: 0,
        presence: 'online',
        ratingBp: 495,
        reviews: 156,
        completed: 520,
        services: [
          ['chat_per_message', 'Tirage Ciblé par Message', 'Analyse écrite détaillée par message.', 350, null],
          ['chat_per_minute', 'Tchat Intuitif en Direct', 'Conversation en temps réel à la minute.', 250, null],
          ['scheduled_appointment', 'Séance Clarté Relationnelle (45 min)', 'Rendez-vous individuel dédié.', 7800, 45],
          ['phone_per_minute', 'Ligne Directe Privée', 'Consultation vocale facturée à la minute.', 290, null],
        ] as const,
      },
      {
        userId: exp4UserId,
        email: 'soraya@maison-astralis.demo',
        firstName: 'Soraya',
        lastName: 'Benali',
        slug: 'soraya-benali',
        displayName: 'Soraya Benali',
        headline: 'Cartomancienne Classique & Spécialiste Petit Lenormand',
        specialty: 'Cartomancie Classique',
        category: 'cartomancy',
        bio: 'Spécialiste du Grand Tableau Lenormand à 36 cartes, offrant des perspectives concrètes et structurées sur vos choix immédiats et les prochains trimestres.',
        years: 9,
        langs: ['fr'],
        tools: ['Petit Lenormand', 'Grand Tableau', 'Jeu 32 Cartes'],
        avatar: '/src/assets/images/expert_portrait_nadia_1794559555197.jpg',
        featured: 0,
        presence: 'online',
        ratingBp: 478,
        reviews: 63,
        completed: 190,
        services: [
          ['chat_per_minute', 'Tchat Lenormand en Direct', 'Lecture en temps réel à la minute.', 220, null],
          ['scheduled_appointment', 'Grand Tableau Complet (30 min)', 'Consultation sur tirage 36 cartes.', 5900, 30],
        ] as const,
      },
      {
        userId: exp5UserId,
        email: 'henri@maison-astralis.demo',
        firstName: 'Henri',
        lastName: 'Valois',
        slug: 'henri-valois',
        displayName: 'Henri Valois',
        headline: 'Astrologue Électionnel & Spécialiste en Synastrie',
        specialty: 'Astrologie Électionnelle',
        category: 'astrology',
        bio: 'Spécialisé dans le choix des moments propices, la synastrie de couple et l’étude des transits majeurs pour des engagements durables.',
        years: 19,
        langs: ['fr'],
        tools: ['Éphémérides Électionnelles', 'Cartes de Synastrie', 'Étoiles Fixes'],
        avatar: '/src/assets/images/expert_portrait_marcus_1794559554785.jpg',
        featured: 0,
        presence: 'offline',
        ratingBp: 488,
        reviews: 81,
        completed: 310,
        services: [
          ['chat_fixed', 'Note de Synastrie Écrite', 'Étude comparative écrite à tarif fixe.', 5500, 30],
          ['scheduled_appointment', 'Séance Calendrier Électionnel (60 min)', 'Alignement approfondi de vos projets.', 12000, 60],
        ] as const,
      },
      {
        userId: exp6UserId,
        email: 'elena@maison-astralis.demo',
        firstName: 'Elena',
        lastName: 'Rostova',
        slug: 'elena-rostova',
        displayName: 'Elena Rostova',
        headline: 'Médium Intuitive & Conseil Archétypal',
        specialty: 'Guidance Intuitive',
        category: 'mediumship',
        bio: 'Séances intuitives calmes et bienveillantes intégrant l’interprétation des symboles oniriques et le discernement intérieur.',
        years: 12,
        langs: ['fr'],
        tools: ['Symbolique des Rêves', 'Tarot Contemplatif', 'Guidance'],
        avatar: '/src/assets/images/expert_portrait_celeste_1794559554136.jpg',
        featured: 0,
        presence: 'online',
        ratingBp: 484,
        reviews: 72,
        completed: 245,
        services: [
          ['chat_per_message', 'Échange Réflexif par Message', 'Réponse approfondie par message.', 400, null],
          ['chat_per_minute', 'Tchat Contemplatif en Direct', 'Dialogue écrit en temps réel.', 270, null],
          ['scheduled_appointment', 'Guidance Approfondie (45 min)', 'Consultation privée sur rendez-vous.', 8900, 45],
        ] as const,
      },
    ];

    const insExp = db.prepare(`
      INSERT INTO expert_profiles (
        id, user_id, slug, display_name, headline, specialty, category_slug,
        biography, years_experience, languages_json, tools_json, avatar_url,
        cover_url, is_verified, is_featured, status, presence_status,
        rating_avg_bp, review_count, completed_consultations, is_demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'approved', ?, ?, ?, ?, 1, ?, ?)
    `);
    const insService = db.prepare(`
      INSERT INTO expert_services (id, expert_id, service_type, title, description, price_cents, currency, duration_minutes, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, 1, ?, ?)
    `);
    const insAvail = db.prepare(`
      INSERT INTO expert_availability (id, expert_id, day_of_week, start_time, end_time, is_break, timezone, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Europe/Paris', ?)
    `);

    const expertIds: string[] = [];
    const expertServiceIds: Record<string, string> = {};

    for (const e of expertsData) {
      insUser.run(e.userId, e.email, expertPass, 'active', ts, ts);
      insRole.run(uuid(), e.userId, 'expert', ts);
      insClient.run(e.userId, e.firstName, e.lastName, '+33699000000', 'fr', 'Europe/Paris', ts, ts);
      insWallet.run(e.userId, 0, 'EUR', ts);
      insNotifPref.run(e.userId);

      const expertId = uuid();
      expertIds.push(expertId);
      insExp.run(
        expertId, e.userId, e.slug, e.displayName, e.headline, e.specialty, e.category,
        e.bio, e.years, JSON.stringify(e.langs), JSON.stringify(e.tools), e.avatar,
        '/src/assets/images/hero_celestial_observatory_1794559552701.jpg',
        e.featured, e.presence, e.ratingBp, e.reviews, e.completed, ts, ts
      );

      for (const [stype, title, desc, price, dur] of e.services) {
        const sid = uuid();
        if (!expertServiceIds[e.slug]) expertServiceIds[e.slug] = sid;
        insService.run(sid, expertId, stype, title, desc, price, dur, ts, ts);
      }

      for (let d = 1; d <= 6; d++) {
        insAvail.run(uuid(), expertId, d, '09:00', '13:00', 0, ts);
        insAvail.run(uuid(), expertId, d, '13:00', '14:00', 1, ts);
        insAvail.run(uuid(), expertId, d, '14:00', '19:00', 0, ts);
      }
    }

    // Seed completed consultations, chat history, earnings, and reviews
    const c1Id = uuid();
    const c2Id = uuid();
    const svc1 = expertServiceIds['celeste-moreau'];
    const svc3 = expertServiceIds['nadia-mansour'];

    db.prepare(`
      INSERT INTO consultations (id, client_id, expert_id, service_id, service_type, billing_model, unit_price_cents, currency, status, units_consumed, gross_amount_cents, commission_bp, commission_cents, expert_net_cents, started_at, ended_at, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'chat_per_message', 'per_message', 390, 'EUR', 'completed', 5, 1950, 2500, 488, 1462, ?, ?, 1, ?, ?)
    `).run(c1Id, client1Id, expertIds[0], svc1, ts, ts, ts, ts);

    db.prepare(`
      INSERT INTO consultations (id, client_id, expert_id, service_id, service_type, billing_model, unit_price_cents, currency, status, units_consumed, gross_amount_cents, commission_bp, commission_cents, expert_net_cents, started_at, ended_at, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'chat_per_minute', 'per_minute', 250, 'EUR', 'completed', 12, 3000, 2500, 750, 2250, ?, ?, 1, ?, ?)
    `).run(c2Id, client1Id, expertIds[2], svc3, ts, ts, ts, ts);

    db.prepare('INSERT INTO expert_earnings (id, expert_id, consultation_id, gross_cents, commission_cents, net_cents, status, created_at) VALUES (?, ?, ?, 1950, 488, 1462, ?, ?)')
      .run(uuid(), expertIds[0], c1Id, 'available', ts);
    db.prepare('INSERT INTO expert_earnings (id, expert_id, consultation_id, gross_cents, commission_cents, net_cents, status, created_at) VALUES (?, ?, ?, 3000, 750, 2250, ?, ?)')
      .run(uuid(), expertIds[2], c2Id, 'available', ts);

    const conv1Id = uuid();
    db.prepare('INSERT INTO chat_conversations (id, consultation_id, client_id, expert_id, status, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(conv1Id, c1Id, client1Id, expertIds[0], 'open', ts, ts);
    db.prepare('INSERT INTO chat_messages (id, conversation_id, sender_id, content, is_read, billed_cents, created_at) VALUES (?, ?, ?, ?, 1, 390, ?)')
      .run(uuid(), conv1Id, client1Id, 'Bonsoir Céleste. Saturne traverse mon ascendant ce mois-ci et j’hésite entre deux engagements professionnels.', ts);
    db.prepare('INSERT INTO chat_messages (id, conversation_id, sender_id, content, is_read, billed_cents, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)')
      .run(uuid(), conv1Id, exp1UserId, 'Bienvenue Claire. Un transit de Saturne sur l’ascendant invite à privilégier la clarté structurelle plutôt que la précipitation.', ts);

    db.prepare('INSERT INTO reviews (id, consultation_id, client_id, expert_id, rating, comment, expert_reply, status, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 5, ?, ?, ?, 1, ?, ?)')
      .run(uuid(), c1Id, client1Id, expertIds[0], 'Une lecture remarquablement structurée et posée. Céleste a expliqué les cycles planétaires avec une grande précision.', 'Merci Claire, je vous souhaite beaucoup de sérénité durant ce passage.', 'published', ts, ts);
    db.prepare('INSERT INTO reviews (id, consultation_id, client_id, expert_id, rating, comment, status, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 5, ?, ?, 1, ?, ?)')
      .run(uuid(), c2Id, client1Id, expertIds[2], 'Calme, attentive et très juste dans ses observations. M’a aidée à aborder une discussion délicate avec recul.', 'published', ts, ts);

    db.prepare('INSERT INTO favorites (id, client_id, expert_id, created_at) VALUES (?, ?, ?, ?)')
      .run(uuid(), client1Id, expertIds[0], ts);
    db.prepare('INSERT INTO favorites (id, client_id, expert_id, created_at) VALUES (?, ?, ?, ?)')
      .run(uuid(), client1Id, expertIds[2], ts);

    const tomorrow = new Date(Date.now() + 86400000);
    tomorrow.setUTCHours(15, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrow.getTime() + 45 * 60000);
    db.prepare('INSERT INTO appointments (id, client_id, expert_id, service_id, scheduled_start, scheduled_end, client_timezone, status, price_cents, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 8500, ?, ?, ?)')
      .run(uuid(), client1Id, expertIds[0], svc1, tomorrow.toISOString(), tomorrowEnd.toISOString(), 'Europe/Paris', 'confirmed', 'Analyse annuelle de révolution solaire', ts, ts);

    db.prepare(`
      INSERT INTO expert_applications (id, full_name, display_name, email, phone, country, languages_json, specialties_json, years_experience, biography, methods_json, portfolio_url, status, internal_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(), 'Amélie Deschamps', 'Amélie Deschamps', 'amelie.applicant@example.org', '+33677889900',
      'France', JSON.stringify(['fr']), JSON.stringify(['Tarot', 'Astrologie']), 8,
      'Huit années de pratique privée à Strasbourg mêlant astrologie psychologique et Tarot de Marseille.',
      JSON.stringify(['chat', 'scheduled_appointment']), 'https://example.org/portfolio/amelie',
      'submitted', 'Dossier solide ; entretien déontologique à planifier.', ts, ts
    );

    const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString();
    db.prepare('INSERT INTO reward_campaigns (id, name, description, points_multiplier_bp, bonus_points, starts_at, ends_at, is_active) VALUES (?, ?, ?, 15000, 100, ?, ?, 1)')
      .run(uuid(), 'Bonus Fidélité Équinoxe', 'Gagnez 1,5x Points Astraux sur toutes vos consultations ce mois-ci.', ts, nextMonth);

    db.prepare('INSERT INTO coupons (id, code, discount_type, discount_value, points_cost, max_uses, used_count, is_active, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)')
      .run(uuid(), 'ASTRAL10', 'fixed_cents', 1000, 500, 1000, nextMonth, ts);
    db.prepare('INSERT INTO coupons (id, code, discount_type, discount_value, points_cost, max_uses, used_count, is_active, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)')
      .run(uuid(), 'BIENVENUE15', 'percent_bp', 1500, 0, 500, nextMonth, ts);

    const insArtCat = db.prepare('INSERT INTO article_categories (id, slug, name) VALUES (?, ?, ?)');
    insArtCat.run(uuid(), 'astrology-essays', 'Essais Astrologiques');
    insArtCat.run(uuid(), 'tarot-studies', 'Études du Tarot');
    insArtCat.run(uuid(), 'contemplative-practice', 'Pratique Contemplative');

    const insArt = db.prepare(`
      INSERT INTO articles (id, slug, category_slug, author_name, title, excerpt, content, cover_url, tags_json, seo_title, seo_description, status, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)
    `);
    insArt.run(
      uuid(),
      'navigating-saturn-returns-with-clarity',
      'astrology-essays',
      'Céleste Moreau',
      'Traverser les Transitions Planétaires sans Fatalisme',
      'Comment les techniques de chronologie hellénistique éclairent les tournants de vie comme des invitations à la structure.',
      'Dans les traditions astrologiques classiques, les transits des planètes lentes n’ont jamais été lus comme des verdicts figés. Ils marquent des saisons de maturité et de discernement.\n\nAvant une consultation de thème natal, notez trois questions concrètes plutôt que de chercher des réponses binaires. Le symbolisme sert avant tout à éclairer des choix responsables.',
      '/src/assets/images/hero_celestial_observatory_1794559552701.jpg',
      JSON.stringify(['Saturne', 'Astrologie', 'Cycles']),
      'Traverser les Transitions Planétaires | Au-delà des Étoiles',
      'Essai éditorial sur l’astrologie classique et le discernement.',
      ts, ts, ts
    );
    insArt.run(
      uuid(),
      'architecture-of-the-major-arcana',
      'tarot-studies',
      'Nadia Mansour',
      'L’Architecture des Arcanes Majeurs en Pratique Privée',
      'Pourquoi les vingt-deux lames majeures demeurent une grammaire visuelle précieuse pour la réflexion.',
      'Bien avant les manuels modernes, les Arcanes Majeurs formaient un parcours allégorique du potentiel ouvert (Le Mat) à l’accomplissement intégré (Le Monde).\n\nUn tirage structuré en trois cartes — Situation, Tension, Intégration — permet d’examiner une situation avec calme et rigueur.',
      '/src/assets/images/editorial_tarot_spread_1794559555868.jpg',
      JSON.stringify(['Tarot', 'Arcanes Majeurs', 'Méthodologie']),
      'Architecture des Arcanes Majeurs | Au-delà des Étoiles',
      'Comprendre la structure des Arcanes Majeurs.',
      ts, ts, ts
    );
    insArt.run(
      uuid(),
      'pythagorean-cycles-and-vocational-timing',
      'contemplative-practice',
      'Marcus Vance',
      'Cycles Pythagoriciens et Patience Stratégique',
      'Cartographier les rythmes numérologiques sur neuf ans pour distinguer les saisons de semis et de consolidation.',
      'En numérologie pythagoricienne, chaque année civile inaugure une cadence particulière de 1 à 9. Identifier votre année personnelle évite bien des frictions inutiles.\n\nPlutôt que de forcer l’expansion durant une année d’introspection, la patience stratégique renforce la clarté.',
      '/src/assets/images/hero_celestial_observatory_1794559552701.jpg',
      JSON.stringify(['Numérologie', 'Cycles', 'Orientation']),
      'Cycles Pythagoriciens | Au-delà des Étoiles',
      'Rythmes numérologiques sur neuf ans.',
      ts, ts, ts
    );

    // 12 Signes du Zodiaque en français
    const signsFr: Array<[string, string]> = [
      ['aries', 'Bélier'],
      ['taurus', 'Taureau'],
      ['gemini', 'Gémeaux'],
      ['cancer', 'Cancer'],
      ['leo', 'Lion'],
      ['virgo', 'Vierge'],
      ['libra', 'Balance'],
      ['scorpio', 'Scorpion'],
      ['sagittarius', 'Sagittaire'],
      ['capricorn', 'Capricorne'],
      ['aquarius', 'Verseau'],
      ['pisces', 'Poissons'],
    ];
    const periods: Array<'daily' | 'weekly' | 'monthly' | 'yearly'> = ['daily', 'weekly', 'monthly', 'yearly'];
    const periodLabels: Record<string, string> = {
      daily: 'du jour',
      weekly: 'de la semaine',
      monthly: 'du mois',
      yearly: 'de l’année',
    };
    const insHoro = db.prepare('INSERT INTO horoscopes (id, sign, period, period_key, overview, love_guidance, career_guidance, lucky_number, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    signsFr.forEach(([signKey, signName], idx) => {
      periods.forEach((period, pIdx) => {
        insHoro.run(
          uuid(),
          signKey,
          period,
          'current',
          `${signName} aborde ce cycle ${periodLabels[period]} avec une clarté mesurée. Privilégiez vos engagements essentiels et écartez les distractions superflues.`,
          `Dans vos relations, une parole calme et directe porte davantage que les attentes implicites. Restez attentif à l’écoute mutuelle.`,
          `Les projets professionnels favorisent les propositions structurées et le suivi patient plutôt que la hâte.`,
          ((idx * 3 + pIdx + 7) % 33) + 1,
          ts
        );
      });
    });

    // Tarot Cards (Arcanes Majeurs en français)
    const tarotDeck: Array<[number, string, string, string, string, string, string, string]> = [
      [0, 'the-fool', 'Le Mat', 'Arcane Majeur', 'Air', 'Nouveaux départs, ouverture d’esprit, confiance dans le premier pas.', 'Hésitation, dispersion, manque de préparation pratique.', 'Avancez avec curiosité tout en gardant les pieds sur terre.'],
      [1, 'the-magician', 'Le Bateleur', 'Arcane Majeur', 'Air', 'Maîtrise des outils, alignement de l’intention et de l’action, ingéniosité.', 'Ambition dispersée, doute sur ses propres capacités.', 'Tout ce dont vous avez besoin pour agir est déjà à votre portée.'],
      [2, 'the-high-priestess', 'La Papesse', 'Arcane Majeur', 'Eau', 'Discernement silencieux, sagesse intérieure, patience avant d’agir.', 'Retenue excessive, impatience face au silence.', 'Laissez la question mûrir avant d’exiger une réponse immédiate.'],
      [3, 'the-empress', 'L’Impératrice', 'Arcane Majeur', 'Terre', 'Fécondité créative, croissance sereine, expression claire.', 'Surmenage, oubli de votre équilibre quotidien.', 'Prenez soin des conditions qui permettent un développement durable.'],
      [4, 'the-emperor', 'L’Empereur', 'Arcane Majeur', 'Feu', 'Structure, limites saines, responsabilité et stabilité.', 'Rigidité, confusion entre autorité et contrôle.', 'Établissez un cadre clair qui protège l’essentiel.'],
      [5, 'the-hierophant', 'Le Pape', 'Arcane Majeur', 'Terre', 'Transmission, éthique partagée, conseil avisé.', 'Dogmatisme, suivi aveugle des habitudes.', 'Appuyez-vous sur une tradition éprouvée tout en gardant votre discernement.'],
      [6, 'the-lovers', 'L’Amoureux', 'Arcane Majeur', 'Air', 'Choix conscient, réciprocité, alignement avec vos valeurs.', 'Indécision, loyautés partagées.', 'Choisissez en accord avec vos principes profonds.'],
      [7, 'the-chariot', 'Le Chariot', 'Arcane Majeur', 'Eau', 'Élan maîtrisé, synthèse des forces contraires, détermination.', 'Précipitation sans cap précis.', 'Tenez fermement les rênes et fixez un horizon clair.'],
      [8, 'strength', 'La Force', 'Arcane Majeur', 'Feu', 'Maîtrise tranquille, douceur sous pression, endurance.', 'Doute de soi, réaction impulsive.', 'La véritable force s’exprime avec sérénité.'],
      [9, 'the-hermit', 'L’Ermite', 'Arcane Majeur', 'Terre', 'Retrait fécond, lucidité intérieure, recherche de vérité.', 'Isolement subi, repli par crainte.', 'Prenez un temps de recul afin d’entendre votre propre jugement.'],
      [10, 'wheel-of-fortune', 'La Roue de Fortune', 'Arcane Majeur', 'Feu', 'Tournant de cycle, opportunité de timing, mouvement.', 'Résistance au changement naturel.', 'Restez centré au cœur du mouvement plutôt que de lutter contre le cycle.'],
      [11, 'justice', 'La Justice', 'Arcane Majeur', 'Air', 'Équité, clarté des faits, responsabilité équilibrée.', 'Évitement des conséquences, jugement hâtif.', 'Pesez chaque élément avec honnêteté et mesure.'],
      [14, 'temperance', 'Tempérance', 'Arcane Majeur', 'Feu', 'Alchimie, rythme juste, harmonie retrouvée.', 'Déséquilibre, précipitation.', 'Associez patience et action dans une juste proportion.'],
      [17, 'the-star', 'L’Étoile', 'Arcane Majeur', 'Air', 'Renouveau apaisé, clarté après l’épreuve, espérance lucide.', 'Découragement, oubli des signes positifs.', 'Consacrez votre énergie à ce qui nourrit durablement votre vocation.'],
      [18, 'the-moon', 'La Lune', 'Arcane Majeur', 'Eau', 'Traversée de l’incertitude, intuition fine, vie onirique.', 'Projection d’inquiétudes dans le flou.', 'Avancez prudemment avec la lumière disponible jusqu’à l’éclaircie.'],
      [19, 'the-sun', 'Le Soleil', 'Arcane Majeur', 'Feu', 'Transparence, vitalité, réussite partagée.', 'Fatigue passagère voilant vos acquis.', 'Laissez la clarté et la franchise guider votre prochaine étape.'],
      [21, 'the-world', 'Le Monde', 'Arcane Majeur', 'Terre', 'Accomplissement d’un cycle, intégration, plénitude.', 'Laisser des étapes inachevées.', 'Honorez le chemin parcouru avant d’ouvrir un nouveau chapitre.'],
    ];
    const insTarot = db.prepare('INSERT INTO tarot_cards (id, number, slug, name, arcana, element, upright_meaning, reversed_meaning, guidance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [num, slug, name, arcana, el, up, rev, guid] of tarotDeck) {
      insTarot.run(uuid(), num, slug, name, arcana, el, up, rev, guid);
    }

    // FAQs en français
    const faqs = [
      ['Consultations', 'Comment fonctionnent les tarifs et l’offre gratuite à 0,00 € ?', 'Chaque conseiller affiche son tarif habituel barré ainsi que l’offre découverte active à 0,00 € pour votre première prise de contact. Toutes les conditions tarifaires sont transparentes avant le démarrage de la séance.'],
      ['Experts', 'Comment les conseillers sont-ils vérifiés ?', 'Chaque candidat soumet son parcours, ses spécialités et sa charte déontologique à l’équipe d’administration avant d’obtenir le statut de Conseiller Vérifié.'],
      ['Confidentialité', 'Mes échanges par tchat restent-ils privés ?', 'Oui. Les conversations sont strictement limitées à vous et à votre conseiller, protégées par des contrôles d’accès authentifiés côté serveur.'],
      ['Appel Direct', 'Comment fonctionne l’icône téléphone verte à côté des conseillers en direct ?', 'Cliquez sur l’icône téléphone verte pour ouvrir un ticket d’appel direct affichant immédiatement le numéro central de mise en relation (Main Number), modifiable à tout moment par l’administration.'],
      ['Paiements', 'Quels moyens de paiement sont pris en charge ?', 'Notre architecture vérifie la disponibilité régionale des prestataires (cartes bancaires, portefeuilles numériques) avant validation. En environnement de test, les crédits sandbox sont clairement signalés.'],
    ];
    const insFaq = db.prepare('INSERT INTO faqs (id, category, question, answer, sort_order, is_published) VALUES (?, ?, ?, ?, ?, 1)');
    faqs.forEach(([cat, q, a], i) => insFaq.run(uuid(), cat, q, a, i + 1));

    // Support Ticket
    const t1Id = uuid();
    db.prepare('INSERT INTO support_tickets (id, user_id, category, priority, status, subject, internal_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t1Id, client1Id, 'billing', 'normal', 'resolved', 'Question sur la validité des points de fidélité', 'Politique de 365 jours confirmée.', ts, ts);
    db.prepare('INSERT INTO support_messages (id, ticket_id, sender_id, is_staff, content, created_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(uuid(), t1Id, client1Id, 'Bonjour, pouvez-vous confirmer la durée de validité de mes Points Astraux Or ?', ts);
    db.prepare('INSERT INTO support_messages (id, ticket_id, sender_id, is_staff, content, created_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(uuid(), t1Id, adminId, 'Bonjour Claire, vos Points Astraux restent valables 365 jours à compter de chaque opération éligible.', ts);

    // Notification
    db.prepare('INSERT INTO notifications (id, user_id, type, title, body, link_url, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(uuid(), client1Id, 'appointment_reminder', 'Rendez-vous confirmé', 'Votre lecture de thème natal (45 min) avec Céleste Moreau est confirmée.', '/account/appointments', ts);
  });

  seedTx();
}
