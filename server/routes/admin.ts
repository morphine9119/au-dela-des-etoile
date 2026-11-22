import { Router } from '../http/express-lite.ts';
import crypto from 'node:crypto';
import { z } from 'zod';
import { hashPassword, requireRole, writeAuditLog } from '../auth.ts';
import { db, nowIso, uuid } from '../db.ts';
import { creditWalletAtomic } from '../services/finance.ts';
import { SUPPORT_STATUS_MESSAGES } from '../../src/lib/supportStatusMessages.ts';

export const adminRouter = Router();
adminRouter.use(requireRole('admin', 'staff'));

const AVATAR_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
// Durable Object SQLite rows are limited to 2 MB, so avatars are capped just below that.
const MAX_AVATAR_BYTES = 1_900_000;

function removeManagedAvatar(avatarUrl: string | null): void {
  if (!avatarUrl?.startsWith('/uploads/expert-avatars/')) return;
  const filename = avatarUrl.slice('/uploads/expert-avatars/'.length);
  db.prepare('DELETE FROM uploaded_files WHERE filename = ?').run(filename);
}

type SupportSource = 'support' | 'contact';

function getAdminTickets(archived = false) {
  const archiveFilter = archived ? 'IS NOT NULL' : 'IS NULL';
  return db.prepare(`
    SELECT st.id, st.subject, u.email AS user_email,
      COALESCE(cp.first_name || ' ' || cp.last_name, u.email) AS contact_name,
      st.status, st.category, st.priority, st.created_at, st.updated_at,
      (SELECT content FROM support_messages sm WHERE sm.ticket_id = st.id ORDER BY sm.created_at DESC LIMIT 1) AS message,
      (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = st.id AND sm.is_staff = 0 AND sm.is_read = 0) AS unread_count,
      st.archived_at, 'support' AS source
    FROM support_tickets st
    JOIN users u ON u.id = st.user_id
    LEFT JOIN client_profiles cp ON cp.user_id = u.id
    WHERE st.archived_at ${archiveFilter}
    UNION ALL
    SELECT cm.id, cm.subject, cm.email AS user_email, cm.name AS contact_name,
      cm.status, 'contact' AS category, 'normal' AS priority,
      cm.created_at, cm.updated_at,
      COALESCE((SELECT content FROM contact_message_replies cr WHERE cr.contact_message_id = cm.id ORDER BY cr.created_at DESC LIMIT 1), cm.message) AS message,
      (CASE WHEN cm.is_read = 0 THEN 1 ELSE 0 END) +
        (SELECT COUNT(*) FROM contact_message_replies cr
         WHERE cr.contact_message_id = cm.id AND cr.is_staff = 0 AND cr.is_read = 0) AS unread_count,
      cm.archived_at, 'contact' AS source
    FROM contact_messages cm
    WHERE cm.archived_at ${archiveFilter}
    ORDER BY updated_at DESC
  `).all();
}

function getSupportRecord(source: SupportSource, id: string) {
  if (source === 'support') {
    return db.prepare(`
      SELECT st.id, st.subject, st.status, st.archived_at, u.id AS user_id,
        u.email AS user_email, COALESCE(cp.first_name || ' ' || cp.last_name, u.email) AS contact_name
      FROM support_tickets st
      JOIN users u ON u.id = st.user_id
      LEFT JOIN client_profiles cp ON cp.user_id = u.id
      WHERE st.id = ?
    `).get(id) as
      | { id: string; subject: string; status: string; archived_at: string | null; user_id: string; user_email: string; contact_name: string }
      | undefined;
  }
  return db.prepare(`
    SELECT id, subject, status, archived_at, user_id, email AS user_email, name AS contact_name
    FROM contact_messages
    WHERE id = ?
  `).get(id) as
    | { id: string; subject: string; status: string; archived_at: string | null; user_id: string | null; user_email: string; contact_name: string }
    | undefined;
}

function addClientSupportNotification(userId: string, subject: string): void {
  db.prepare(`
    INSERT INTO notifications (id, user_id, type, title, body, link_url, is_read, created_at)
    VALUES (?, ?, 'support_reply', 'Nouvelle réponse du support', ?, '/account/support', 0, ?)
  `).run(uuid(), userId, `Une réponse est disponible pour « ${subject} ».`, nowIso());
}

type ForeignKeyColumn = { from: string; to: string };
type ForeignKeyReference = { childTable: string; columns: ForeignKeyColumn[] };
type DatabaseRow = Record<string, unknown>;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function getForeignKeyReferences(): {
  referencesByParent: Map<string, ForeignKeyReference[]>;
  primaryKeys: Map<string, string[]>;
} {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
    name: string;
  }>;
  const primaryKeys = new Map<string, string[]>();
  const referencesByParent = new Map<string, ForeignKeyReference[]>();

  for (const { name } of tables) {
    const columns = db.pragma(`table_info(${quoteIdentifier(name)})`) as Array<{ name: string; pk: number }>;
    primaryKeys.set(name, columns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name));
  }

  for (const { name: childTable } of tables) {
    const foreignKeys = db.pragma(`foreign_key_list(${quoteIdentifier(childTable)})`) as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>;
    const constraints = new Map<number, typeof foreignKeys>();
    for (const foreignKey of foreignKeys) {
      const constraint = constraints.get(foreignKey.id) || [];
      constraint.push(foreignKey);
      constraints.set(foreignKey.id, constraint);
    }

    for (const [constraintId, constraint] of constraints) {
      const parentTable = constraint[0].table;
      const parentKeys = primaryKeys.get(parentTable) || [];
      const columns = constraint
        .sort((a, b) => a.seq - b.seq)
        .map((foreignKey) => ({
          from: foreignKey.from,
          to: foreignKey.to || parentKeys[foreignKey.seq] || '',
        }));
      if (columns.some((column) => !column.to)) {
        throw new Error(`Unable to resolve foreign key ${childTable}.${constraintId}`);
      }
      const references = referencesByParent.get(parentTable) || [];
      references.push({ childTable, columns });
      referencesByParent.set(parentTable, references);
    }
  }

  return { referencesByParent, primaryKeys };
}

function deleteRowAndReferences(
  tableName: string,
  row: DatabaseRow,
  referencesByParent: Map<string, ForeignKeyReference[]>,
  primaryKeys: Map<string, string[]>,
  deletedRows: Set<string>
): void {
  const keyColumns = primaryKeys.get(tableName) || [];
  if (keyColumns.length === 0) {
    throw new Error(`Cannot safely delete linked records from ${tableName}: primary key not found`);
  }
  const keyValues = keyColumns.map((column) => row[column]);
  const rowKey = `${tableName}:${JSON.stringify(keyValues)}`;
  if (deletedRows.has(rowKey)) return;
  deletedRows.add(rowKey);

  for (const reference of referencesByParent.get(tableName) || []) {
    const values = reference.columns.map((column) => row[column.to]);
    if (values.some((value) => value === null || value === undefined)) continue;
    const where = reference.columns.map((column) => `${quoteIdentifier(column.from)} = ?`).join(' AND ');
    const children = db.prepare(`SELECT * FROM ${quoteIdentifier(reference.childTable)} WHERE ${where}`)
      .all(...values) as DatabaseRow[];
    for (const child of children) {
      deleteRowAndReferences(reference.childTable, child, referencesByParent, primaryKeys, deletedRows);
    }
  }

  const where = keyColumns.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
  db.prepare(`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${where}`).run(...keyValues);
}

adminRouter.get('/overview', (req, res) => {
  const usersSince = typeof req.query.usersSince === 'string' ? req.query.usersSince : undefined;
  const parsedUsersSince = usersSince ? z.string().datetime().safeParse(usersSince) : null;
  if (parsedUsersSince && !parsedUsersSince.success) {
    res.status(400).json({ error: 'Date de dernière visite invalide' });
    return;
  }
  const totalClients = (db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS c
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    WHERE ur.role = 'client'
      AND u.deleted_at IS NULL
      AND u.status != 'deleted'
      AND u.is_demo = 0
  `).get() as { c: number }).c;
  const activeExperts = (db.prepare("SELECT COUNT(*) as c FROM expert_profiles WHERE status = 'approved'").get() as { c: number }).c;
  const pendingApplications = (db.prepare("SELECT COUNT(*) as c FROM expert_applications WHERE status IN ('submitted', 'under_review', 'interview')").get() as { c: number }).c;
  const newUsers = parsedUsersSince
    ? (db.prepare('SELECT COUNT(*) as c FROM users WHERE deleted_at IS NULL AND created_at > ?').get(parsedUsersSince.data) as { c: number }).c
    : 0;
  const totalConsultations = (db.prepare('SELECT COUNT(*) as c FROM consultations').get() as { c: number }).c;
  const activeSessions = (db.prepare("SELECT COUNT(*) as c FROM consultations WHERE status = 'active'").get() as { c: number }).c;

  const financials = db
    .prepare(`
      SELECT
        COALESCE(SUM(gross_amount_cents), 0) as gross_revenue_cents,
        COALESCE(SUM(commission_cents), 0) as platform_commission_cents
      FROM consultations
      WHERE status = 'completed'
    `)
    .get() as { gross_revenue_cents: number; platform_commission_cents: number };

  const refundsTotalCents = (
    db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as c FROM refunds WHERE status = 'processed'").get() as { c: number }
  ).c;

  const openTickets = (db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM support_tickets WHERE archived_at IS NULL AND status IN ('open', 'in_progress', 'waiting_customer')) +
      (SELECT COUNT(*) FROM contact_messages WHERE archived_at IS NULL AND status IN ('new', 'open', 'in_progress', 'waiting_customer')) AS c
  `).get() as { c: number }).c;
  const unreadSupportMessages = (db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM support_messages sm JOIN support_tickets st ON st.id = sm.ticket_id
       WHERE st.archived_at IS NULL AND sm.is_staff = 0 AND sm.is_read = 0) +
      (SELECT COUNT(*) FROM contact_messages WHERE archived_at IS NULL AND is_read = 0) +
      (SELECT COUNT(*) FROM contact_message_replies cr JOIN contact_messages cm ON cm.id = cr.contact_message_id
       WHERE cm.archived_at IS NULL AND cr.is_staff = 0 AND cr.is_read = 0) AS c
  `).get() as { c: number }).c;

  res.json({
    totalClients,
    activeExperts,
    pendingApplications,
    newUsers,
    totalConsultations,
    activeSessions,
    grossRevenueCents: financials.gross_revenue_cents,
    platformCommissionCents: financials.platform_commission_cents,
    refundsTotalCents,
    openTickets,
    unreadSupportMessages,
  });
});

// Users
adminRouter.get('/users', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const users = db
    .prepare(`
      SELECT u.id, u.email, u.status, u.email_verified, u.is_demo, u.created_at,
        cp.first_name, cp.last_name, cp.phone, cp.preferred_language,
        GROUP_CONCAT(ur.role) as roles_csv
      FROM users u
      LEFT JOIN client_profiles cp ON cp.user_id = u.id
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.deleted_at IS NULL
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `)
    .all() as Array<Record<string, unknown> & { email: string; first_name?: string; last_name?: string }>;

  const filtered = q
    ? users.filter(
        (u) =>
          u.email.toLowerCase().includes(q) ||
          (u.first_name || '').toLowerCase().includes(q) ||
          (u.last_name || '').toLowerCase().includes(q) ||
          (typeof u.phone === 'string' && u.phone.toLowerCase().includes(q))
      )
    : users;

  res.json({ users: filtered });
});

adminRouter.delete('/users/:id', requireRole('admin'), (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.deleted_at, GROUP_CONCAT(ur.role) AS roles_csv
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    WHERE u.id = ?
    GROUP BY u.id
  `).get(req.params.id) as { id: string; deleted_at: string | null; roles_csv: string | null } | undefined;

  if (!user || user.deleted_at) {
    res.status(404).json({ error: 'Utilisateur introuvable' });
    return;
  }
  if (user.id === req.authUser!.id || user.roles_csv?.split(',').includes('admin')) {
    res.status(409).json({ error: 'Vous ne pouvez pas supprimer votre propre compte ni un compte administrateur.' });
    return;
  }

  const ts = nowIso();
  db.transaction(() => {
    db.prepare("UPDATE users SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, user.id);
    db.prepare("UPDATE expert_profiles SET status = 'suspended', presence_status = 'offline', updated_at = ? WHERE user_id = ?")
      .run(ts, user.id);
  })();

  writeAuditLog({
    actorId: req.authUser!.id,
    action: 'admin.user_deleted',
    entityType: 'user',
    entityId: user.id,
    details: { softDelete: true },
  });
  res.json({ ok: true });
});

adminRouter.patch('/users/:id', (req, res) => {
  const schema = z.object({
    status: z.enum(['active', 'suspended', 'deactivated']).optional(),
    role: z.enum(['client', 'expert', 'admin', 'staff']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Mise à jour utilisateur invalide' });
    return;
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as { id: string } | undefined;
  if (!user) {
    res.status(404).json({ error: 'Utilisateur introuvable' });
    return;
  }
  if (parsed.data.status && req.params.id === req.authUser!.id && parsed.data.status !== 'active') {
    res.status(409).json({ error: 'Vous ne pouvez pas suspendre ou désactiver votre propre compte.' });
    return;
  }
  const ts = nowIso();
  if (parsed.data.status) {
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(parsed.data.status, ts, req.params.id);
    writeAuditLog({ actorId: req.authUser!.id, action: `admin.user_status_${parsed.data.status}`, entityType: 'user', entityId: req.params.id });
  }
  if (parsed.data.role) {
    db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(uuid(), req.params.id, parsed.data.role, ts);
    writeAuditLog({ actorId: req.authUser!.id, action: 'admin.user_role_granted', entityType: 'user', entityId: req.params.id, details: { role: parsed.data.role } });
  }
  res.json({ ok: true });
});

// Experts
adminRouter.get('/experts', (_req, res) => {
  const experts = db
    .prepare(`
      SELECT ep.*, u.email, u.status as user_status
      FROM expert_profiles ep
      JOIN users u ON u.id = ep.user_id
      WHERE u.deleted_at IS NULL
      ORDER BY ep.created_at DESC
    `)
    .all();
  res.json({ experts });
});

adminRouter.post('/experts', (req, res) => {
  const schema = z.object({
    displayName: z.string().trim().min(2).max(120),
    specialty: z.string().trim().min(2).max(120).optional().default('Tarot'),
    status: z.enum(['pending', 'approved', 'suspended', 'rejected']).optional().default('suspended'),
    presenceStatus: z.enum(['online', 'busy', 'offline']).optional().default('offline'),
    externalChatUrl: z.string().trim().max(2048).url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'Le lien doit utiliser HTTP ou HTTPS').nullable().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Création de conseiller invalide' });
    return;
  }

  const ts = nowIso();
  const specialty = parsed.data.specialty.trim();
  const displayName = parsed.data.displayName.trim();
  const baseSlug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'expert';
  const categoryRow = db.prepare('SELECT slug FROM expert_categories ORDER BY sort_order LIMIT 1').get() as { slug?: string } | undefined;
  const categorySlug = categoryRow?.slug || 'tarot';
  const expertId = uuid();
  const userId = uuid();
  const userEmail = `${baseSlug}-${expertId}@maison-astralis.local`;
  const temporaryPassword = crypto.randomBytes(24).toString('hex');

  db.transaction(() => {
    const [firstName, ...rest] = displayName.split(/\s+/);
    const lastName = rest.join(' ') || 'Conseiller';
    db.prepare(
      'INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)'
    ).run(userId, userEmail, hashPassword(temporaryPassword), parsed.data.status === 'approved' ? 'active' : 'suspended', ts, ts);
    db.prepare(
      'INSERT INTO client_profiles (user_id, first_name, last_name, phone, preferred_language, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, firstName || 'Conseiller', lastName, null, 'fr', 'Europe/Paris', ts, ts);
    db.prepare('INSERT INTO wallets (user_id, available_cents, pending_cents, currency, updated_at) VALUES (?, 0, 0, ?, ?)')
      .run(userId, 'EUR', ts);

    db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(uuid(), userId, 'expert', ts);

    const slug = `${baseSlug}-${expertId}`;
    db.prepare(`
      INSERT INTO expert_profiles (
        id, user_id, slug, display_name, headline, specialty, category_slug,
        biography, years_experience, languages_json, tools_json, avatar_url,
        external_chat_url, is_verified, is_featured, status, presence_status,
        rating_avg_bp, review_count, completed_consultations, custom_commission_bp,
        is_demo, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3, '["fr","en"]', '[]', NULL, ?, 0, 0, ?, ?, 0, 0, 0, NULL, 0, ?, ?)
    `).run(
      expertId,
      userId,
      slug,
      displayName,
      `Conseiller en ${specialty}`,
      specialty,
      categorySlug,
      `Conseiller ${specialty.toLowerCase()} ajouté depuis la console d’administration.`,
      parsed.data.externalChatUrl ?? null,
      parsed.data.status,
      parsed.data.presenceStatus,
      ts,
      ts
    );

    db.prepare(`
      INSERT INTO expert_services (
        id, expert_id, service_type, title, description, price_cents, currency, duration_minutes, is_active, created_at, updated_at
      ) VALUES (?, ?, 'chat_per_minute', ?, ?, 250, 'EUR', 30, 1, ?, ?)
    `).run(uuid(), expertId, `Consultation ${specialty}`, `Séance privée de ${specialty.toLowerCase()} en direct.`, ts, ts);
  })();

  const slug = `${baseSlug}-${expertId}`;
  writeAuditLog({ actorId: req.authUser!.id, action: 'admin.expert_created', entityType: 'expert_profile', entityId: expertId, details: { displayName, specialty, email: userEmail } });
  res.status(201).json({ ok: true, expertId, slug, email: userEmail, temporaryPassword });
});

adminRouter.delete('/experts/:id', (req, res) => {
  const expert = db.prepare('SELECT id, user_id, avatar_url FROM expert_profiles WHERE id = ?').get(req.params.id) as
    | { id: string; user_id: string; avatar_url: string | null }
    | undefined;
  if (!expert) {
    res.status(404).json({ error: 'Conseiller introuvable' });
    return;
  }

  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    db.prepare('DELETE FROM commission_rules WHERE scope = ? AND target_id = ?').run('expert', expert.id);
    db.prepare('DELETE FROM audit_logs WHERE entity_id = ?').run(expert.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(expert.user_id) as DatabaseRow | undefined;
    if (!user) throw new Error('Expert account not found during deletion');
    const { referencesByParent, primaryKeys } = getForeignKeyReferences();
    const isAdminAccount = db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin'").get(expert.user_id);
    if (isAdminAccount) {
      const expertProfile = db.prepare('SELECT * FROM expert_profiles WHERE id = ?').get(expert.id) as DatabaseRow | undefined;
      if (!expertProfile) throw new Error('Expert profile not found during deletion');
      deleteRowAndReferences('expert_profiles', expertProfile, referencesByParent, primaryKeys, new Set());
      db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role = 'expert'").run(expert.user_id);
    } else {
      db.prepare('UPDATE expert_applications SET reviewed_by = NULL WHERE reviewed_by = ?').run(expert.user_id);
      db.prepare('UPDATE refunds SET reviewed_by = NULL WHERE reviewed_by = ?').run(expert.user_id);
      db.prepare('UPDATE withdrawals SET reviewed_by = NULL WHERE reviewed_by = ?').run(expert.user_id);
      deleteRowAndReferences('users', user, referencesByParent, primaryKeys, new Set());
    }
    writeAuditLog({
      actorId: req.authUser!.id,
      action: 'admin.expert_permanently_deleted',
      entityType: 'expert_profile',
      entityId: expert.id,
      details: { permanent: true },
    });
  })();

  removeManagedAvatar(expert.avatar_url);
  res.json({ ok: true });
});

adminRouter.patch('/experts/:id', (req, res) => {
  const schema = z.object({
    status: z.enum(['pending', 'approved', 'suspended', 'rejected']).optional(),
    presenceStatus: z.enum(['online', 'busy', 'offline']).optional(),
    displayName: z.string().trim().min(2).max(120).optional(),
    headline: z.string().trim().min(2).max(160).optional(),
    specialty: z.string().trim().min(2).max(120).optional(),
    biography: z.string().trim().min(1).max(5000).optional(),
    yearsExperience: z.number().int().min(0).max(80).optional(),
    completedConsultations: z.number().int().min(0).max(2_147_483_647).optional(),
    languages: z.array(z.string().trim().min(2).max(50)).min(1).max(10).optional(),
    isVerified: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
    customCommissionBp: z.number().int().min(0).max(8000).nullable().optional(),
    ratingOverrideBp: z.number().int().min(0).max(500).nullable().optional(),
    reviewCountOverride: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
    externalChatUrl: z.string().trim().max(2048).url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'Le lien doit utiliser HTTP ou HTTPS').nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Mise à jour conseiller invalide' });
    return;
  }
  const existing = db.prepare(`
    SELECT ep.status, ep.presence_status, ep.display_name, ep.headline, ep.specialty,
      ep.biography, ep.years_experience, ep.completed_consultations, ep.languages_json, ep.is_verified, ep.is_featured,
      ep.custom_commission_bp, ep.rating_override_bp, ep.review_count_override,
      ep.external_chat_url, ep.user_id, u.deleted_at AS user_deleted_at
    FROM expert_profiles ep
    JOIN users u ON u.id = ep.user_id
    WHERE ep.id = ?
  `).get(req.params.id) as
    | {
        status: string;
        presence_status: string;
        display_name: string;
        headline: string;
        specialty: string;
        biography: string;
        years_experience: number;
        completed_consultations: number;
        languages_json: string;
        is_verified: number;
        is_featured: number;
        custom_commission_bp: number | null;
        rating_override_bp: number | null;
        review_count_override: number | null;
        external_chat_url: string | null;
        user_id: string;
        user_deleted_at: string | null;
      }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Conseiller introuvable' });
    return;
  }
  if (parsed.data.status === 'approved' && existing.user_deleted_at) {
    res.status(409).json({ error: 'Le compte de ce conseiller a été supprimé et ne peut pas être approuvé.' });
    return;
  }
  const ts = nowIso();
  const nextStatus = parsed.data.status ?? existing.status;
  const nextPresenceStatus = parsed.data.presenceStatus
    ?? (parsed.data.status
      ? nextStatus === 'approved' ? existing.presence_status : 'offline'
      : existing.presence_status);
  db.transaction(() => {
    const shouldSetFeatured = parsed.data.isFeatured !== undefined ? parsed.data.isFeatured : existing.is_featured === 1;
    if (parsed.data.isFeatured !== undefined) {
      if (parsed.data.isFeatured) {
        db.prepare('UPDATE expert_profiles SET is_featured = 0, updated_at = ? WHERE id != ?').run(ts, req.params.id);
      } else {
        db.prepare('UPDATE expert_profiles SET is_featured = 0, updated_at = ? WHERE id = ?').run(ts, req.params.id);
      }
    } else if (shouldSetFeatured && existing.is_featured === 0) {
      db.prepare('UPDATE expert_profiles SET is_featured = 0, updated_at = ? WHERE id != ?').run(ts, req.params.id);
    }
    db.prepare(`
    UPDATE expert_profiles
    SET status = ?, presence_status = ?, display_name = ?, headline = ?, specialty = ?,
      biography = ?, years_experience = ?, completed_consultations = ?, languages_json = ?, is_verified = ?, is_featured = ?,
      custom_commission_bp = ?, external_chat_url = ?, rating_override_bp = ?,
      review_count_override = ?, updated_at = ?
    WHERE id = ?
    `).run(
      nextStatus,
      nextPresenceStatus,
      parsed.data.displayName ?? existing.display_name,
      parsed.data.headline ?? existing.headline,
      parsed.data.specialty ?? existing.specialty,
      parsed.data.biography ?? existing.biography,
      parsed.data.yearsExperience ?? existing.years_experience,
      parsed.data.completedConsultations ?? existing.completed_consultations,
      parsed.data.languages ? JSON.stringify(parsed.data.languages) : existing.languages_json,
      parsed.data.isVerified !== undefined ? (parsed.data.isVerified ? 1 : 0) : existing.is_verified,
      parsed.data.isFeatured !== undefined ? (parsed.data.isFeatured ? 1 : 0) : existing.is_featured,
      parsed.data.customCommissionBp !== undefined ? parsed.data.customCommissionBp : existing.custom_commission_bp,
      parsed.data.externalChatUrl !== undefined ? parsed.data.externalChatUrl : existing.external_chat_url,
      parsed.data.ratingOverrideBp !== undefined ? parsed.data.ratingOverrideBp : existing.rating_override_bp,
      parsed.data.reviewCountOverride !== undefined ? parsed.data.reviewCountOverride : existing.review_count_override,
      ts,
      req.params.id
    );

    if (parsed.data.status) {
      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(parsed.data.status === 'approved' ? 'active' : 'suspended', ts, existing.user_id);
      if (parsed.data.status === 'approved' && existing.status !== 'approved') {
        db.prepare('INSERT INTO notifications (id, user_id, type, title, body, link_url, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
          .run(uuid(), existing.user_id, 'expert_approval', 'Profil Conseiller Approuvé', 'Votre profil conseiller est maintenant visible sur Au-delà des Étoiles.', '/expert/dashboard', ts);
      }
    }
  })();
  writeAuditLog({ actorId: req.authUser!.id, action: 'admin.expert_updated', entityType: 'expert_profile', entityId: req.params.id, details: parsed.data });
  res.json({ ok: true });
});

adminRouter.post('/experts/:id/avatar', (req, res) => {
  const parsed = z.object({
    imageDataUrl: z.string().max(6_000_000).regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Image invalide ou trop volumineuse' });
    return;
  }

  const expert = db.prepare('SELECT avatar_url FROM expert_profiles WHERE id = ?').get(req.params.id) as
    | { avatar_url: string | null }
    | undefined;
  if (!expert) {
    res.status(404).json({ error: 'Conseiller introuvable' });
    return;
  }

  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(parsed.data.imageDataUrl);
  if (!match) {
    res.status(400).json({ error: 'Format d’image non pris en charge' });
    return;
  }
  const mimeType = match[1];
  const imageBuffer = Buffer.from(match[2], 'base64');
  const signatureMatches =
    (mimeType === 'image/jpeg' && imageBuffer.length >= 3 && imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff) ||
    (mimeType === 'image/png' && imageBuffer.length >= 8 && imageBuffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (mimeType === 'image/webp' && imageBuffer.length >= 12 && imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP');
  if (!signatureMatches || imageBuffer.length > MAX_AVATAR_BYTES) {
    res.status(400).json({ error: 'Le contenu de l’image est invalide ou trop volumineux (max 1,9 Mo)' });
    return;
  }

  const filename = `${uuid()}${AVATAR_MIME_EXTENSIONS[mimeType]}`;
  const avatarUrl = `/uploads/expert-avatars/${filename}`;
  db.transaction(() => {
    db.prepare('INSERT INTO uploaded_files (filename, mime_type, data, created_at) VALUES (?, ?, ?, ?)')
      .run(filename, mimeType, new Uint8Array(imageBuffer), nowIso());
    db.prepare('UPDATE expert_profiles SET avatar_url = ?, updated_at = ? WHERE id = ?')
      .run(avatarUrl, nowIso(), req.params.id);
  })();
  removeManagedAvatar(expert.avatar_url);
  writeAuditLog({
    actorId: req.authUser!.id,
    action: 'admin.expert_avatar_updated',
    entityType: 'expert_profile',
    entityId: req.params.id,
  });
  res.json({ avatarUrl });
});

adminRouter.delete('/experts/:id/avatar', (req, res) => {
  const expert = db.prepare('SELECT avatar_url FROM expert_profiles WHERE id = ?').get(req.params.id) as
    | { avatar_url: string | null }
    | undefined;
  if (!expert) {
    res.status(404).json({ error: 'Conseiller introuvable' });
    return;
  }
  db.prepare('UPDATE expert_profiles SET avatar_url = NULL, updated_at = ? WHERE id = ?')
    .run(nowIso(), req.params.id);
  removeManagedAvatar(expert.avatar_url);
  writeAuditLog({
    actorId: req.authUser!.id,
    action: 'admin.expert_avatar_removed',
    entityType: 'expert_profile',
    entityId: req.params.id,
  });
  res.json({ avatarUrl: null });
});

// Applications & Conversion to Expert Account
adminRouter.get('/applications', requireRole('admin'), (_req, res) => {
  const applications = db.prepare("SELECT * FROM expert_applications WHERE status NOT IN ('approved', 'activated') ORDER BY created_at DESC").all();
  res.json({ applications });
});

adminRouter.delete('/applications/:id', requireRole('admin'), (req, res) => {
  const deleteApplication = db.transaction(() => {
    const result = db.prepare('DELETE FROM expert_applications WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return false;
    writeAuditLog({
      actorId: req.authUser!.id,
      action: 'admin.application_rejected_and_deleted',
      entityType: 'expert_application',
      entityId: req.params.id,
      details: { permanent: true },
    });
    return true;
  });

  if (!deleteApplication()) {
    res.status(404).json({ error: 'Candidature introuvable' });
    return;
  }
  res.json({ ok: true });
});

adminRouter.patch('/applications/:id', requireRole('admin'), (req, res) => {
  const schema = z.object({
    status: z.enum(['submitted', 'under_review', 'interview', 'approved', 'activated']),
    internalNotes: z.string().max(2000).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Mise à jour de candidature invalide' });
    return;
  }

  const app = db.prepare('SELECT * FROM expert_applications WHERE id = ?').get(req.params.id) as
    | {
        id: string;
        user_id: string | null;
        full_name: string;
        display_name: string;
        email: string;
        phone: string;
        languages_json: string;
        specialties_json: string;
        years_experience: number;
        biography: string;
        status: string;
      }
    | undefined;
  if (!app) {
    res.status(404).json({ error: 'Candidature introuvable' });
    return;
  }

  const ts = nowIso();
  db.transaction(() => {
    if (parsed.data.status !== 'approved' && parsed.data.status !== 'activated') {
      db.prepare('UPDATE expert_applications SET status = ?, internal_notes = COALESCE(?, internal_notes), reviewed_by = ?, updated_at = ? WHERE id = ?')
        .run(parsed.data.status, parsed.data.internalNotes ?? null, req.authUser!.id, ts, app.id);
    }

    if (parsed.data.status === 'approved' || parsed.data.status === 'activated') {
      let targetUserId = app.user_id;
      if (!targetUserId) {
        const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(app.email.toLowerCase()) as { id: string } | undefined;
        if (existingUser) {
          targetUserId = existingUser.id;
        } else {
          targetUserId = uuid();
          const tempPass = hashPassword('AstralisExpert2026!');
          db.prepare('INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)')
            .run(targetUserId, app.email.toLowerCase(), tempPass, 'suspended', ts, ts);
          const [first, ...rest] = app.full_name.split(' ');
          db.prepare('INSERT INTO client_profiles (user_id, first_name, last_name, phone, preferred_language, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(targetUserId, first || app.display_name, rest.join(' ') || 'Conseiller', app.phone, 'fr', 'Europe/Paris', ts, ts);
          db.prepare('INSERT INTO wallets (user_id, available_cents, pending_cents, currency, updated_at) VALUES (?, 0, 0, ?, ?)').run(targetUserId, 'EUR', ts);
        }
      }

      db.prepare(`
        UPDATE users
        SET status = 'suspended', updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_roles WHERE user_id = users.id AND role = 'admin'
          )
      `)
        .run(ts, targetUserId);
      db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(uuid(), targetUserId, 'expert', ts);

      const existingExpert = db.prepare('SELECT id FROM expert_profiles WHERE user_id = ?').get(targetUserId) as { id: string } | undefined;
      if (!existingExpert) {
        const expertId = uuid();
        const slug = `${app.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${expertId.slice(0, 4)}`;
        const specialties = JSON.parse(app.specialties_json) as string[];
        db.prepare(`
          INSERT INTO expert_profiles (
            id, user_id, slug, display_name, headline, specialty, category_slug,
            biography, years_experience, languages_json, tools_json, avatar_url,
            is_verified, is_featured, status, presence_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'tarot', ?, ?, ?, '[]', '/src/assets/images/expert_portrait_celeste_1794559554136.jpg', 1, 0, 'suspended', 'offline', ?, ?)
        `).run(expertId, targetUserId, slug, app.display_name, `Conseiller en ${specialties[0] || 'Guidance'}`, specialties[0] || 'Tarot & Guidance', app.biography, app.years_experience, app.languages_json, ts, ts);

        db.prepare(`
          INSERT INTO expert_services (id, expert_id, service_type, title, description, price_cents, currency, is_active, created_at, updated_at)
          VALUES (?, ?, 'chat_per_minute', 'Consultation en Direct', 'Séance privée de guidance en direct.', 250, 'EUR', 1, ?, ?)
        `).run(uuid(), expertId, ts, ts);
      } else {
        db.prepare("UPDATE expert_profiles SET status = 'suspended', presence_status = 'offline', updated_at = ? WHERE id = ?")
          .run(ts, existingExpert.id);
      }

      db.prepare('DELETE FROM expert_applications WHERE id = ?').run(app.id);
    }
  })();

  writeAuditLog({ actorId: req.authUser!.id, action: `admin.application_${parsed.data.status}`, entityType: 'expert_application', entityId: app.id });
  res.json({ ok: true });
});

// Consultations & Financials
adminRouter.get('/consultations', (_req, res) => {
  const consultations = db
    .prepare(`
      SELECT c.*, ep.display_name as expert_name, cp.first_name || ' ' || cp.last_name as client_name
      FROM consultations c
      JOIN expert_profiles ep ON ep.id = c.expert_id
      JOIN client_profiles cp ON cp.user_id = c.client_id
      ORDER BY c.created_at DESC
      LIMIT 100
    `)
    .all();
  res.json({ consultations });
});

adminRouter.get('/financials', (_req, res) => {
  const payments = db.prepare('SELECT p.*, u.email FROM payments p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 60').all();
  const refunds = db.prepare('SELECT r.*, u.email FROM refunds r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 60').all();
  const withdrawals = db
    .prepare('SELECT w.*, ep.display_name as expert_name FROM withdrawals w JOIN expert_profiles ep ON ep.id = w.expert_id ORDER BY w.created_at DESC LIMIT 60')
    .all();
  const commissionRules = db.prepare('SELECT * FROM commission_rules ORDER BY created_at DESC').all();
  const ledger = db.prepare('SELECT wt.*, u.email FROM wallet_transactions wt JOIN users u ON u.id = wt.user_id ORDER BY wt.created_at DESC LIMIT 100').all();

  res.json({ payments, refunds, withdrawals, commissionRules, ledger });
});

adminRouter.post('/refunds/:id/process', (req, res) => {
  const decision = req.body?.decision;
  if (decision !== 'processed' && decision !== 'rejected') {
    res.status(400).json({ error: 'La décision doit être traitée ou refusée' });
    return;
  }
  const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(req.params.id) as
    | { id: string; user_id: string; amount_cents: number; status: string }
    | undefined;
  if (!refund || refund.status !== 'requested') {
    res.status(404).json({ error: 'Demande de remboursement en attente introuvable' });
    return;
  }

  const ts = nowIso();
  const decisionLabel = decision === 'processed' ? 'acceptée' : 'refusée';
  db.transaction(() => {
    db.prepare('UPDATE refunds SET status = ?, reviewed_by = ?, updated_at = ? WHERE id = ?').run(decision, req.authUser!.id, ts, refund.id);
    if (decision === 'processed') {
      creditWalletAtomic({
        userId: refund.user_id,
        amountCents: refund.amount_cents,
        type: 'refund',
        referenceType: 'refund',
        referenceId: refund.id,
        description: `Remboursement approuvé (${(refund.amount_cents / 100).toFixed(2)} €)`,
        idempotencyKey: `refund-credit-${refund.id}`,
      });
    }
    db.prepare('INSERT INTO notifications (id, user_id, type, title, body, link_url, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(uuid(), refund.user_id, 'refund_status', `Demande de remboursement ${decisionLabel}`, `Votre demande de remboursement de ${(refund.amount_cents / 100).toFixed(2)} € a été ${decisionLabel}.`, '/account/wallet', ts);
  })();

  writeAuditLog({ actorId: req.authUser!.id, action: `admin.refund_${decision}`, entityType: 'refund', entityId: refund.id });
  res.json({ ok: true });
});

adminRouter.post('/withdrawals/:id/process', (req, res) => {
  const decision = req.body?.decision;
  if (!['approved', 'paid', 'rejected'].includes(decision)) {
    res.status(400).json({ error: 'Décision de retrait invalide' });
    return;
  }
  const w = db.prepare('SELECT id FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w) {
    res.status(404).json({ error: 'Retrait introuvable' });
    return;
  }
  db.prepare('UPDATE withdrawals SET status = ?, reviewed_by = ?, updated_at = ? WHERE id = ?')
    .run(decision, req.authUser!.id, nowIso(), req.params.id);
  writeAuditLog({ actorId: req.authUser!.id, action: `admin.withdrawal_${decision}`, entityType: 'withdrawal', entityId: req.params.id });
  res.json({ ok: true });
});

adminRouter.post('/commissions', (req, res) => {
  const schema = z.object({
    scope: z.enum(['global', 'expert', 'service_type', 'promotional']),
    targetId: z.string().nullable().optional(),
    rateBp: z.number().int().min(0).max(8000),
    description: z.string().min(4).max(200),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Règle de commission invalide' });
    return;
  }
  const id = uuid();
  db.prepare('INSERT INTO commission_rules (id, scope, target_id, rate_bp, description, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, parsed.data.scope, parsed.data.targetId ?? null, parsed.data.rateBp, parsed.data.description.trim(), nowIso());
  writeAuditLog({ actorId: req.authUser!.id, action: 'admin.commission_rule_created', entityType: 'commission_rule', entityId: id, details: parsed.data });
  res.status(201).json({ ok: true, id });
});

// Reviews Moderation
adminRouter.get('/reviews', (_req, res) => {
  const reviews = db
    .prepare(`
      SELECT r.*, ep.display_name as expert_name, cp.first_name || ' ' || cp.last_name as client_name
      FROM reviews r
      JOIN expert_profiles ep ON ep.id = r.expert_id
      LEFT JOIN client_profiles cp ON cp.user_id = r.client_id
      ORDER BY r.created_at DESC
    `)
    .all();
  res.json({ reviews });
});

adminRouter.patch('/reviews/:id', (req, res) => {
  const status = req.body?.status;
  if (!['published', 'flagged', 'removed'].includes(status)) {
    res.status(400).json({ error: 'Statut d’avis invalide' });
    return;
  }
  const review = db.prepare('SELECT id, expert_id FROM reviews WHERE id = ?').get(req.params.id) as
    | { id: string; expert_id: string }
    | undefined;
  if (!review) {
    res.status(404).json({ error: 'Avis introuvable' });
    return;
  }
  const ts = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE reviews SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, review.id);
    const stats = db
      .prepare("SELECT COUNT(*) as count, AVG(rating) as average FROM reviews WHERE expert_id = ? AND status = 'published'")
      .get(review.expert_id) as { count: number; average: number | null };
    db.prepare('UPDATE expert_profiles SET rating_avg_bp = ?, review_count = ?, updated_at = ? WHERE id = ?')
      .run(Math.round((stats.average || 0) * 100), stats.count, ts, review.expert_id);
  })();
  writeAuditLog({ actorId: req.authUser!.id, action: `admin.review_${status}`, entityType: 'review', entityId: req.params.id });
  res.json({ ok: true });
});

// Content CMS, Coupons, Settings, Support, Audit Logs
adminRouter.delete('/audit-logs/:id', requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT id FROM audit_logs WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Entrée de journal introuvable' });
    return;
  }

  db.prepare('DELETE FROM audit_logs WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

adminRouter.delete('/audit-logs', requireRole('admin'), (req, res) => {
  const deletedCount = db.prepare('DELETE FROM audit_logs').run().changes;
  res.json({ ok: true, deletedCount });
});

adminRouter.get('/content', (_req, res) => {
  const articles = db.prepare('SELECT * FROM articles ORDER BY created_at DESC').all();
  const categories = db.prepare('SELECT * FROM expert_categories ORDER BY sort_order ASC').all();
  const coupons = db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
  const settings = db.prepare('SELECT * FROM platform_settings').all();
  const tickets = getAdminTickets();
  const auditLogs = db
    .prepare(`
      SELECT al.*, u.email as actor_email
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.actor_id
      ORDER BY al.created_at DESC
      LIMIT 100
    `)
    .all();

  res.json({ articles, categories, coupons, settings, tickets, auditLogs });
});

adminRouter.get('/support', (_req, res) => {
  res.json({ tickets: getAdminTickets(_req.query.archived === 'true') });
});

adminRouter.post('/articles', (req, res) => {
  const schema = z.object({
    title: z.string().min(4).max(160),
    categorySlug: z.string().min(2),
    authorName: z.string().min(2).max(100),
    excerpt: z.string().min(10).max(400),
    content: z.string().min(20),
    status: z.enum(['draft', 'published']).default('published'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Veuillez renseigner tous les champs de l’article' });
    return;
  }
  const ts = nowIso();
  const id = uuid();
  const slug = `${parsed.data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${id.slice(0, 4)}`;
  db.prepare(`
    INSERT INTO articles (id, slug, category_slug, author_name, title, excerpt, content, cover_url, status, published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '/src/assets/images/editorial_tarot_spread_1794559555868.jpg', ?, ?, ?, ?)
  `).run(id, slug, parsed.data.categorySlug, parsed.data.authorName.trim(), parsed.data.title.trim(), parsed.data.excerpt.trim(), parsed.data.content.trim(), parsed.data.status, parsed.data.status === 'published' ? ts : null, ts, ts);
  writeAuditLog({ actorId: req.authUser!.id, action: 'admin.article_created', entityType: 'article', entityId: id });
  res.status(201).json({ ok: true, id, slug });
});

adminRouter.put('/horoscopes', (req, res) => {
  const schema = z.object({
    sign: z.string().min(2),
    period: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    overview: z.string().min(10),
    loveGuidance: z.string().min(10),
    careerGuidance: z.string().min(10),
    luckyNumber: z.number().int().min(1).max(99),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Entrée d’horoscope invalide' });
    return;
  }
  const ts = nowIso();
  db.prepare(`
    INSERT INTO horoscopes (id, sign, period, period_key, overview, love_guidance, career_guidance, lucky_number, updated_at)
    VALUES (?, ?, ?, 'current', ?, ?, ?, ?, ?)
    ON CONFLICT(sign, period, period_key) DO UPDATE SET
      overview = excluded.overview,
      love_guidance = excluded.love_guidance,
      career_guidance = excluded.career_guidance,
      lucky_number = excluded.lucky_number,
      updated_at = excluded.updated_at
  `).run(uuid(), parsed.data.sign.toLowerCase(), parsed.data.period, parsed.data.overview.trim(), parsed.data.loveGuidance.trim(), parsed.data.careerGuidance.trim(), parsed.data.luckyNumber, ts);
  res.json({ ok: true });
});

adminRouter.post('/coupons', (req, res) => {
  const schema = z.object({
    code: z.string().min(3).max(30),
    discountType: z.enum(['fixed_cents', 'percent_bp']),
    discountValue: z.number().int().positive(),
    pointsCost: z.number().int().min(0).default(0),
    maxUses: z.number().int().positive().nullable().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Configuration de code avantage invalide' });
    return;
  }
  const id = uuid();
  db.prepare('INSERT INTO coupons (id, code, discount_type, discount_value, points_cost, max_uses, used_count, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)')
    .run(id, parsed.data.code.trim().toUpperCase(), parsed.data.discountType, parsed.data.discountValue, parsed.data.pointsCost, parsed.data.maxUses ?? null, nowIso());
  writeAuditLog({ actorId: req.authUser!.id, action: 'admin.coupon_created', entityType: 'coupon', entityId: id });
  res.status(201).json({ ok: true, id });
});

adminRouter.patch('/settings', (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  if (!key) {
    res.status(400).json({ error: 'Clé de paramètre requise' });
    return;
  }
  let value: unknown = req.body.value;
  if (key === 'main_number') {
    const val = typeof req.body.value === 'string' ? req.body.value.trim() : '';
    if (!val || val.length < 6) {
      res.status(400).json({ error: 'Le numéro principal (Main Number) doit être valide' });
      return;
    }
  }
  if (key === 'homepage_stats') {
    const parsed = z.object({
      verifiedExperts: z.number().int().min(0).max(2_147_483_647).nullable(),
      completedConsultations: z.number().int().min(0).max(2_147_483_647).nullable(),
      publishedReviews: z.number().int().min(0).max(2_147_483_647).nullable(),
    }).strict().safeParse(value);
    if (!parsed.success) {
      res.status(400).json({ error: 'Les chiffres de la page d’accueil doivent être des entiers positifs ou vides.' });
      return;
    }
    value = parsed.data;
  }
  db.prepare(`
    INSERT INTO platform_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), nowIso());
  writeAuditLog({ actorId: req.authUser!.id, action: 'admin.setting_updated', entityType: 'platform_settings', entityId: key, details: { value } });
  res.json({ ok: true });
});

adminRouter.get('/support/:source/:id/messages', (req, res) => {
  const parsedSource = z.enum(['support', 'contact']).safeParse(req.params.source);
  if (!parsedSource.success) {
    res.status(400).json({ error: 'Type de demande invalide' });
    return;
  }
  const source = parsedSource.data;
  const record = getSupportRecord(source, req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }

  let messages: Array<Record<string, unknown>>;
  if (source === 'support') {
    db.prepare('UPDATE support_messages SET is_read = 1 WHERE ticket_id = ? AND is_staff = 0').run(req.params.id);
    messages = db.prepare(`
      SELECT id, sender_id, is_staff, content, created_at
      FROM support_messages WHERE ticket_id = ? ORDER BY created_at ASC
    `).all(req.params.id) as Array<Record<string, unknown>>;
  } else {
    db.prepare('UPDATE contact_messages SET is_read = 1 WHERE id = ?').run(req.params.id);
    db.prepare('UPDATE contact_message_replies SET is_read = 1 WHERE contact_message_id = ? AND is_staff = 0').run(req.params.id);
    const original = db.prepare(`
      SELECT id, NULL AS sender_id, 0 AS is_staff, message AS content, created_at
      FROM contact_messages WHERE id = ?
    `).get(req.params.id) as Record<string, unknown>;
    const replies = db.prepare(`
      SELECT id, sender_id, is_staff, content, created_at
      FROM contact_message_replies WHERE contact_message_id = ? ORDER BY created_at ASC
    `).all(req.params.id) as Array<Record<string, unknown>>;
    messages = [original, ...replies].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }
  res.json({ ticket: record, messages });
});

adminRouter.post('/support/:source/:id/messages', (req, res) => {
  const parsedSource = z.enum(['support', 'contact']).safeParse(req.params.source);
  const parsedBody = z.object({ content: z.string().trim().min(1).max(4000) }).safeParse(req.body);
  if (!parsedSource.success || !parsedBody.success) {
    res.status(400).json({ error: 'Le message doit contenir entre 1 et 4000 caractères' });
    return;
  }
  const source = parsedSource.data;
  const record = getSupportRecord(source, req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  if (record.archived_at) {
    res.status(409).json({ error: 'Cette demande est archivée.' });
    return;
  }

  const id = uuid();
  const ts = nowIso();
  const nextStatus = record.status === 'resolved' || record.status === 'closed'
    ? record.status
    : 'waiting_customer';
  if (source === 'support') {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO support_messages
          (id, ticket_id, sender_id, is_staff, content, created_at, is_read, email_delivery_status)
        VALUES (?, ?, ?, 1, ?, ?, 0, 'in_app')
      `).run(id, req.params.id, req.authUser!.id, parsedBody.data.content, ts);
      db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?')
        .run(nextStatus, ts, req.params.id);
      addClientSupportNotification(record.user_id!, record.subject);
    })();
  } else {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO contact_message_replies
          (id, contact_message_id, sender_id, is_staff, content, created_at, is_read, email_delivery_status)
        VALUES (?, ?, ?, 1, ?, ?, 0, 'in_app')
      `).run(id, req.params.id, req.authUser!.id, parsedBody.data.content, ts);
      db.prepare('UPDATE contact_messages SET status = ?, updated_at = ? WHERE id = ?')
        .run(nextStatus, ts, req.params.id);
      if (record.user_id) addClientSupportNotification(record.user_id, record.subject);
    })();
  }
  writeAuditLog({
    actorId: req.authUser!.id,
    action: 'admin.support_replied',
    entityType: source === 'support' ? 'support_ticket' : 'contact_message',
    entityId: req.params.id,
  });

  res.status(201).json({ ok: true, delivery: 'in_app' });
});

adminRouter.patch('/support/:source/:id/status', (req, res) => {
  const parsedSource = z.enum(['support', 'contact']).safeParse(req.params.source);
  const parsedBody = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']) }).safeParse(req.body);
  if (!parsedSource.success || !parsedBody.success) {
    res.status(400).json({ error: 'Statut de ticket invalide' });
    return;
  }
  const source = parsedSource.data;
  const status = parsedBody.data.status;
  const record = getSupportRecord(source, req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  if (record.archived_at) {
    res.status(409).json({ error: 'Cette demande est archivée.' });
    return;
  }
  if (status === 'open') {
    if (record.status === 'resolved' || record.status === 'closed') {
      res.json({ ok: true, status: record.status });
      return;
    }
    if (record.status !== 'open') {
      const ts = nowIso();
      if (source === 'support') {
        db.prepare("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?").run(ts, req.params.id);
      } else {
        db.prepare("UPDATE contact_messages SET status = 'open', updated_at = ? WHERE id = ?").run(ts, req.params.id);
      }
      writeAuditLog({
        actorId: req.authUser!.id,
        action: 'admin.support_opened',
        entityType: source === 'support' ? 'support_ticket' : 'contact_message',
        entityId: req.params.id,
      });
    }
    res.json({ ok: true, status: 'open' });
    return;
  }
  if (record.status === status) {
    res.json({ ok: true, status });
    return;
  }

  const ts = nowIso();
  const statusMessage = SUPPORT_STATUS_MESSAGES[status];
  const messageId = uuid();
  const finalStatus = status;
  if (source === 'support') {
    db.transaction(() => {
      db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(finalStatus, ts, req.params.id);
      db.prepare(`
        INSERT INTO support_messages
          (id, ticket_id, sender_id, is_staff, content, created_at, is_read, email_delivery_status)
          VALUES (?, ?, ?, 1, ?, ?, 0, 'in_app')
      `).run(messageId, req.params.id, req.authUser!.id, statusMessage, ts);
      addClientSupportNotification(record.user_id!, record.subject);
    })();
  } else {
    db.transaction(() => {
      db.prepare('UPDATE contact_messages SET status = ?, updated_at = ? WHERE id = ?').run(finalStatus, ts, req.params.id);
      db.prepare(`
        INSERT INTO contact_message_replies
          (id, contact_message_id, sender_id, is_staff, content, created_at, is_read, email_delivery_status)
          VALUES (?, ?, ?, 1, ?, ?, 0, 'in_app')
      `).run(messageId, req.params.id, req.authUser!.id, statusMessage, ts);
      if (record.user_id) addClientSupportNotification(record.user_id, record.subject);
    })();
  }
  writeAuditLog({
    actorId: req.authUser!.id,
    action: `admin.support_${status}`,
    entityType: source === 'support' ? 'support_ticket' : 'contact_message',
    entityId: req.params.id,
  });

  res.json({ ok: true, status: finalStatus, delivery: 'in_app' });
});

adminRouter.delete('/support/:source/:id', (req, res) => {
  const parsedSource = z.enum(['support', 'contact']).safeParse(req.params.source);
  if (!parsedSource.success) {
    res.status(400).json({ error: 'Type de demande invalide' });
    return;
  }
  const source = parsedSource.data;
  const record = getSupportRecord(source, req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  if (source === 'support') {
    db.prepare('UPDATE support_tickets SET archived_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), req.params.id);
  } else {
    const ts = nowIso();
    db.prepare('UPDATE contact_messages SET archived_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, req.params.id);
  }
  writeAuditLog({
    actorId: req.authUser!.id,
    action: 'admin.support_archived',
    entityType: source === 'support' ? 'support_ticket' : 'contact_message',
    entityId: req.params.id,
  });
  res.json({ ok: true, archived: true });
});

adminRouter.delete('/support/:source/:id/permanent', requireRole('admin'), (req, res) => {
  const parsedSource = z.enum(['support', 'contact']).safeParse(req.params.source);
  if (!parsedSource.success) {
    res.status(400).json({ error: 'Type de demande invalide' });
    return;
  }

  const source = parsedSource.data;
  const result = db.transaction(() => {
    const record = getSupportRecord(source, req.params.id);
    if (!record) return 'not_found';
    if (!record.archived_at) return 'not_archived';

    if (source === 'support') {
      db.prepare('DELETE FROM support_tickets WHERE id = ?').run(req.params.id);
    } else {
      db.prepare('DELETE FROM contact_messages WHERE id = ?').run(req.params.id);
    }

    writeAuditLog({
      actorId: req.authUser!.id,
      action: 'admin.support_permanently_deleted',
      entityType: source === 'support' ? 'support_ticket' : 'contact_message',
      entityId: req.params.id,
    });
    return 'deleted';
  })();

  if (result === 'not_found') {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  if (result === 'not_archived') {
    res.status(409).json({ error: 'Seules les demandes archivées peuvent être supprimées définitivement.' });
    return;
  }
  res.json({ ok: true, deleted: true });
});

adminRouter.post('/support/:source/:id/restore', (req, res) => {
  const parsedSource = z.enum(['support', 'contact']).safeParse(req.params.source);
  if (!parsedSource.success) {
    res.status(400).json({ error: 'Type de demande invalide' });
    return;
  }
  const source = parsedSource.data;
  const record = getSupportRecord(source, req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Ticket introuvable' });
    return;
  }
  if (source === 'support') {
    db.prepare('UPDATE support_tickets SET archived_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), req.params.id);
  } else {
    db.prepare('UPDATE contact_messages SET archived_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), req.params.id);
  }
  writeAuditLog({
    actorId: req.authUser!.id,
    action: 'admin.support_restored',
    entityType: source === 'support' ? 'support_ticket' : 'contact_message',
    entityId: req.params.id,
  });
  res.json({ ok: true, archived: false });
});
