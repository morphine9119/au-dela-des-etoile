import { db, nowIso, uuid } from '../db.ts';

/**
 * Resolve commission rate in basis points (e.g. 2500 = 25.00%)
 * Priority:
 * 1. Expert profile custom_commission_bp (admin override)
 * 2. Active expert-scoped rule
 * 3. Active promotional rule (lowest rate takes precedence)
 * 4. Active service_type rule
 * 5. Active global rule (fallback 2500 = 25%)
 */
export function resolveCommissionRateBp(expertId: string, serviceType: string): number {
  const expert = db
    .prepare('SELECT custom_commission_bp FROM expert_profiles WHERE id = ?')
    .get(expertId) as { custom_commission_bp: number | null } | undefined;

  if (expert && expert.custom_commission_bp !== null && expert.custom_commission_bp !== undefined) {
    return expert.custom_commission_bp;
  }

  const expertRule = db
    .prepare("SELECT rate_bp FROM commission_rules WHERE scope = 'expert' AND target_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1")
    .get(expertId) as { rate_bp: number } | undefined;
  if (expertRule) return expertRule.rate_bp;

  const promoRule = db
    .prepare("SELECT rate_bp FROM commission_rules WHERE scope = 'promotional' AND is_active = 1 ORDER BY rate_bp ASC LIMIT 1")
    .get() as { rate_bp: number } | undefined;
  if (promoRule) return promoRule.rate_bp;

  const serviceRule = db
    .prepare("SELECT rate_bp FROM commission_rules WHERE scope = 'service_type' AND target_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1")
    .get(serviceType) as { rate_bp: number } | undefined;
  if (serviceRule) return serviceRule.rate_bp;

  const globalRule = db
    .prepare("SELECT rate_bp FROM commission_rules WHERE scope = 'global' AND is_active = 1 ORDER BY created_at DESC LIMIT 1")
    .get() as { rate_bp: number } | undefined;

  return globalRule ? globalRule.rate_bp : 2500;
}

/**
 * Pure integer arithmetic for commission & expert net earnings.
 * Never uses floating point for final ledger cents.
 */
export function calculateFinancialSplit(grossCents: number, commissionBp: number): {
  grossCents: number;
  commissionCents: number;
  expertNetCents: number;
} {
  if (!Number.isInteger(grossCents) || grossCents < 0) {
    throw new Error('grossCents must be a non-negative integer');
  }
  if (!Number.isInteger(commissionBp) || commissionBp < 0 || commissionBp > 10000) {
    throw new Error('commissionBp must be an integer between 0 and 10000');
  }
  const commissionCents = Math.round((grossCents * commissionBp) / 10000);
  const expertNetCents = grossCents - commissionCents;
  return { grossCents, commissionCents, expertNetCents };
}

export function calculateLoyaltyPointsForSpend(amountCents: number, multiplierBp = 10000): number {
  if (amountCents <= 0) return 0;
  const setting = db.prepare("SELECT value_json FROM platform_settings WHERE key = 'points_per_euro'").get() as
    | { value_json: string }
    | undefined;
  const pointsPerEuro = setting ? Number(JSON.parse(setting.value_json)) : 10;
  const basePoints = Math.floor((amountCents * pointsPerEuro) / 100);
  return Math.floor((basePoints * multiplierBp) / 10000);
}

export function determineLoyaltyTier(lifetimePoints: number): 'silver' | 'gold' | 'celestial' {
  if (lifetimePoints >= 5000) return 'celestial';
  if (lifetimePoints >= 1000) return 'gold';
  return 'silver';
}

export function ensureWalletExists(userId: string): void {
  const existing = db.prepare('SELECT user_id FROM wallets WHERE user_id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO wallets (user_id, available_cents, pending_cents, currency, updated_at) VALUES (?, 0, 0, ?, ?)')
      .run(userId, 'EUR', nowIso());
  }
}

export const creditWalletAtomic = db.transaction(
  (params: {
    userId: string;
    amountCents: number;
    type: 'credit' | 'refund' | 'adjustment';
    referenceType: string;
    referenceId: string;
    description: string;
    idempotencyKey: string;
  }) => {
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw new Error('Credit amount must be a positive integer');
    }

    const dup = db
      .prepare('SELECT id, balance_after_cents FROM wallet_transactions WHERE idempotency_key = ?')
      .get(params.idempotencyKey) as { id: string; balance_after_cents: number } | undefined;
    if (dup) {
      return { transactionId: dup.id, balanceAfterCents: dup.balance_after_cents, deduplicated: true };
    }

    ensureWalletExists(params.userId);
    const wallet = db.prepare('SELECT available_cents FROM wallets WHERE user_id = ?').get(params.userId) as {
      available_cents: number;
    };

    const nextBalance = wallet.available_cents + params.amountCents;
    const ts = nowIso();
    const txId = uuid();

    db.prepare('UPDATE wallets SET available_cents = ?, updated_at = ? WHERE user_id = ?').run(
      nextBalance,
      ts,
      params.userId
    );
    db.prepare(`
      INSERT INTO wallet_transactions (id, user_id, type, amount_cents, balance_after_cents, reference_type, reference_id, description, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      txId,
      params.userId,
      params.type,
      params.amountCents,
      nextBalance,
      params.referenceType,
      params.referenceId,
      params.description,
      params.idempotencyKey,
      ts
    );

    return { transactionId: txId, balanceAfterCents: nextBalance, deduplicated: false };
  }
);

export const debitWalletAtomic = db.transaction(
  (params: {
    userId: string;
    amountCents: number;
    referenceType: string;
    referenceId: string;
    description: string;
    idempotencyKey: string;
  }) => {
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw new Error('Debit amount must be a positive integer');
    }

    const dup = db
      .prepare('SELECT id, balance_after_cents FROM wallet_transactions WHERE idempotency_key = ?')
      .get(params.idempotencyKey) as { id: string; balance_after_cents: number } | undefined;
    if (dup) {
      return { transactionId: dup.id, balanceAfterCents: dup.balance_after_cents, deduplicated: true };
    }

    ensureWalletExists(params.userId);
    const wallet = db.prepare('SELECT available_cents FROM wallets WHERE user_id = ?').get(params.userId) as {
      available_cents: number;
    };

    if (wallet.available_cents < params.amountCents) {
      throw new Error('INSUFFICIENT_WALLET_BALANCE');
    }

    const nextBalance = wallet.available_cents - params.amountCents;
    const ts = nowIso();
    const txId = uuid();

    db.prepare('UPDATE wallets SET available_cents = ?, updated_at = ? WHERE user_id = ?').run(
      nextBalance,
      ts,
      params.userId
    );
    db.prepare(`
      INSERT INTO wallet_transactions (id, user_id, type, amount_cents, balance_after_cents, reference_type, reference_id, description, idempotency_key, created_at)
      VALUES (?, ?, 'debit', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      txId,
      params.userId,
      -params.amountCents,
      nextBalance,
      params.referenceType,
      params.referenceId,
      params.description,
      params.idempotencyKey,
      ts
    );

    return { transactionId: txId, balanceAfterCents: nextBalance, deduplicated: false };
  }
);

export const awardLoyaltyPointsAtomic = db.transaction(
  (params: {
    userId: string;
    points: number;
    type: 'registration' | 'purchase' | 'daily_claim' | 'referral' | 'admin_adjustment';
    referenceId?: string;
    description: string;
  }) => {
    if (!Number.isInteger(params.points) || params.points === 0) return null;
    const ts = nowIso();
    const acc = db.prepare('SELECT points_balance, lifetime_points FROM loyalty_accounts WHERE user_id = ?').get(params.userId) as
      | { points_balance: number; lifetime_points: number }
      | undefined;
    if (!acc) return null;

    const nextBalance = Math.max(0, acc.points_balance + params.points);
    const nextLifetime = params.points > 0 ? acc.lifetime_points + params.points : acc.lifetime_points;
    const nextTier = determineLoyaltyTier(nextLifetime);

    const expDate = new Date(Date.now() + 365 * 86400000).toISOString();
    db.prepare('UPDATE loyalty_accounts SET points_balance = ?, lifetime_points = ?, tier = ?, updated_at = ? WHERE user_id = ?')
      .run(nextBalance, nextLifetime, nextTier, ts, params.userId);
    db.prepare('INSERT INTO loyalty_transactions (id, user_id, points_delta, type, reference_id, description, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uuid(), params.userId, params.points, params.type, params.referenceId ?? null, params.description, expDate, ts);

    return { pointsBalance: nextBalance, tier: nextTier };
  }
);

export const finalizeConsultationAtomic = db.transaction((consultationId: string) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id = ?').get(consultationId) as
    | {
        id: string;
        client_id: string;
        expert_id: string;
        service_type: string;
        billing_model: string;
        unit_price_cents: number;
        status: string;
        units_consumed: number;
        gross_amount_cents: number;
        started_at: string | null;
      }
    | undefined;

  if (!c) throw new Error('Consultation introuvable');
  if (c.status === 'completed') return c;

  const ts = nowIso();
  let units = c.units_consumed;
  let gross = c.gross_amount_cents;

  if (c.billing_model === 'per_minute') {
    const startMs = c.started_at ? new Date(c.started_at).getTime() : Date.now();
    const elapsedMin = Math.max(1, Math.ceil((Date.now() - startMs) / 60000));
    units = elapsedMin;
    const targetGross = units * c.unit_price_cents;
    const delta = targetGross - gross;
    if (delta > 0) {
      // Debit remaining balance up to available wallet balance
      const wallet = db.prepare('SELECT available_cents FROM wallets WHERE user_id = ?').get(c.client_id) as { available_cents: number };
      const collectible = Math.min(delta, wallet.available_cents);
      if (collectible > 0) {
        debitWalletAtomic({
          userId: c.client_id,
          amountCents: collectible,
          referenceType: 'consultation',
          referenceId: c.id,
          description: `Règlement consultation en direct (${units} min)`,
          idempotencyKey: `consult-settle-${c.id}-${ts}`,
        });
        gross += collectible;
      }
    }
  }

  const commissionBp = resolveCommissionRateBp(c.expert_id, c.service_type);
  const split = calculateFinancialSplit(gross, commissionBp);

  db.prepare(`
    UPDATE consultations
    SET status = 'completed', units_consumed = ?, gross_amount_cents = ?, commission_bp = ?, commission_cents = ?, expert_net_cents = ?, ended_at = ?, updated_at = ?
    WHERE id = ?
  `).run(units, split.grossCents, commissionBp, split.commissionCents, split.expertNetCents, ts, ts, c.id);

  if (split.grossCents > 0) {
    const existingEarning = db.prepare('SELECT id FROM expert_earnings WHERE consultation_id = ?').get(c.id);
    if (!existingEarning) {
      db.prepare(`
        INSERT INTO expert_earnings (id, expert_id, consultation_id, gross_cents, commission_cents, net_cents, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'available', ?)
      `).run(uuid(), c.expert_id, c.id, split.grossCents, split.commissionCents, split.expertNetCents, ts);
    }

    const pts = calculateLoyaltyPointsForSpend(split.grossCents);
    if (pts > 0) {
      awardLoyaltyPointsAtomic({
        userId: c.client_id,
        points: pts,
        type: 'purchase',
        referenceId: c.id,
        description: `${pts} Points Astraux gagnés lors de la consultation`,
      });
    }
  }

  db.prepare('UPDATE expert_profiles SET completed_consultations = completed_consultations + 1, updated_at = ? WHERE id = ?')
    .run(ts, c.expert_id);

  return db.prepare('SELECT * FROM consultations WHERE id = ?').get(c.id);
});
