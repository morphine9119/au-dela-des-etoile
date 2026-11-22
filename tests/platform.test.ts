import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmpDb = path.join(os.tmpdir(), `astralis-test-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.VITEST = 'true';
process.env.DISABLE_HMR = 'true';

const { createServer } = await import('../server/node-server.ts');
const { calculateFinancialSplit, calculateLoyaltyPointsForSpend, resolveCommissionRateBp } = await import('../server/services/finance.ts');
const { getAvailableSlotsForDate } = await import('../server/services/availability.ts');
const { hashPassword, signSessionToken, verifyPassword } = await import('../server/auth.ts');
const { db, initDatabase, uuid } = await import('../server/db.ts');
const { SUPPORT_STATUS_MESSAGES, supportStatusMessageClass } = await import('../src/lib/supportStatusMessages.ts');

let baseUrl = '';
let closeServer: (() => Promise<void>) | null = null;

async function api(route: string, options: RequestInit & { cookie?: string } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers || {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  const data = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, data, setCookie };
}

beforeAll(async () => {
  const { server } = await createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  if (closeServer) await closeServer();
  db.close();
  if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
});

describe('Unit Tests: Financial, Commission & Availability Math', () => {
  it('uses the requested copy and colors for support status messages', () => {
    expect(SUPPORT_STATUS_MESSAGES).toEqual({
      in_progress: 'Votre ticket est actuellement en cours d’examen par notre équipe de support',
      resolved: 'Votre demande a été marquée comme résolue par notre équipe',
      closed: 'Votre demande a été clôturée par notre équipe',
    });
    expect(supportStatusMessageClass(SUPPORT_STATUS_MESSAGES.in_progress)).toContain('text-orange-700');
    expect(supportStatusMessageClass(SUPPORT_STATUS_MESSAGES.resolved)).toContain('text-green-700');
    expect(supportStatusMessageClass(SUPPORT_STATUS_MESSAGES.closed)).toContain('text-red-700');
    expect(supportStatusMessageClass('A regular support reply')).toBeUndefined();
  });

  it('computes exact integer-cents financial splits without floating point drift', () => {
    const split = calculateFinancialSplit(8500, 2500); // 85.00 EUR @ 25%
    expect(split.grossCents).toBe(8500);
    expect(split.commissionCents).toBe(2125);
    expect(split.expertNetCents).toBe(6375);
    expect(split.commissionCents + split.expertNetCents).toBe(split.grossCents);
  });

  it('computes loyalty points accurately for spend', () => {
    expect(calculateLoyaltyPointsForSpend(5000)).toBe(500); // 50 EUR * 10 pts/EUR
    expect(calculateLoyaltyPointsForSpend(5000, 15000)).toBe(750); // 1.5x campaign
  });

  it('resolves service-specific commission rule over global default', () => {
    const expert = db.prepare("SELECT id FROM expert_profiles WHERE slug = 'celeste-moreau'").get() as { id: string };
    expect(resolveCommissionRateBp(expert.id, 'chat_per_message')).toBe(2500);
    expect(resolveCommissionRateBp(expert.id, 'scheduled_appointment')).toBe(2000);
  });

  it('excludes break windows from generated appointment slots', () => {
    const expert = db.prepare("SELECT id FROM expert_profiles WHERE slug = 'celeste-moreau'").get() as { id: string };
    // Pick next Monday
    const d = new Date(Date.now() + 7 * 86400000);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    const dateStr = d.toISOString().slice(0, 10);
    const slots = getAvailableSlotsForDate(expert.id, dateStr, 45);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((s) => s.label.startsWith('13:'))).toBe(false); // 13:00-14:00 is break
  });
});

describe('Security & RBAC Tests', () => {
  it('authenticates the admin username with a hashed password and admin permissions', async () => {
    const adminId = uuid();
    const ts = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at)
      VALUES (?, 'admin@maison-astralis.local', ?, 'active', 1, 0, ?, ?)
    `).run(adminId, hashPassword('1122'), ts, ts);
    db.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(uuid(), adminId, 'admin', ts);

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin', password: '1122' }),
    });

    expect(login.status).toBe(200);
    expect(login.data.user).toMatchObject({ email: 'admin@maison-astralis.local', roles: ['admin'] });
    expect(login.data).not.toHaveProperty('password');
    expect(login.data.user).not.toHaveProperty('password_hash');
    const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(adminId) as { password_hash: string };
    expect(stored.password_hash).not.toBe('1122');
    expect(verifyPassword('1122', stored.password_hash)).toBe(true);

    const cookie = login.setCookie!.split(';')[0];
    expect((await api('/api/admin/overview', { cookie })).status).toBe(200);
  });

  it('keeps admin accounts active when expert applications are approved or refused', async () => {
    const adminId = uuid();
    const ts = new Date().toISOString();
    const adminEmail = `review-admin-${adminId}@example.test`;
    const candidateEmail = `candidate-${adminId}@example.test`;
    let approvedApplicationId = '';
    let selfApplicationId = '';
    let refusedApplicationId = '';
    db.prepare(`
      INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 1, 0, ?, ?)
    `).run(adminId, adminEmail, hashPassword('test-password'), ts, ts);
    db.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(uuid(), adminId, 'admin', ts);
    const cookie = `astralis_session=${signSessionToken(adminId)}`;

    try {
      const submission = await api('/api/public/expert-applications', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          fullName: 'Candidate Expert',
          displayName: 'Candidate',
          email: candidateEmail,
          phone: '+33123456789',
          country: 'France',
          languages: ['fr'],
          specialties: ['Tarot'],
          yearsExperience: 3,
          biography: 'A candidate biography long enough to satisfy the application form requirements.',
          methods: ['chat'],
        }),
      });
      expect(submission.status).toBe(201);
      approvedApplicationId = submission.data.applicationId as string;
      expect(db.prepare('SELECT user_id FROM expert_applications WHERE id = ?').get(approvedApplicationId))
        .toEqual({ user_id: null });

      const approval = await api(`/api/admin/applications/${approvedApplicationId}`, {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ status: 'approved' }),
      });
      expect(approval.status).toBe(200);
      expect(db.prepare('SELECT status FROM users WHERE id = ?').get(adminId)).toEqual({ status: 'active' });
      expect(db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(adminId))
        .toEqual([{ role: 'admin' }]);
      expect(db.prepare('SELECT id FROM users WHERE email = ?').get(candidateEmail)).toBeDefined();

      selfApplicationId = uuid();
      db.prepare(`
        INSERT INTO expert_applications (
          id, user_id, full_name, display_name, email, phone, country, languages_json,
          specialties_json, years_experience, biography, methods_json, status, created_at, updated_at
        ) VALUES (?, ?, 'Admin Candidate', 'Admin Candidate', ?, '+33123456789', 'France', '["fr"]',
          '["Tarot"]', 3, 'A candidate biography long enough to satisfy the application form requirements.',
          '["chat"]', 'submitted', ?, ?)
      `).run(selfApplicationId, adminId, adminEmail, ts, ts);
      const selfApproval = await api(`/api/admin/applications/${selfApplicationId}`, {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ status: 'approved' }),
      });
      expect(selfApproval.status).toBe(200);
      expect(db.prepare('SELECT status FROM users WHERE id = ?').get(adminId)).toEqual({ status: 'active' });
      expect(db.prepare("SELECT role FROM user_roles WHERE user_id = ? AND role = 'admin'").get(adminId))
        .toEqual({ role: 'admin' });

      refusedApplicationId = uuid();
      db.prepare(`
        INSERT INTO expert_applications (
          id, user_id, full_name, display_name, email, phone, country, languages_json,
          specialties_json, years_experience, biography, methods_json, status, created_at, updated_at
        ) VALUES (?, ?, 'Candidate Expert', 'Candidate', ?, '+33123456789', 'France', '["fr"]',
          '["Tarot"]', 3, 'A candidate biography long enough to satisfy the application form requirements.',
          '["chat"]', 'submitted', ?, ?)
      `).run(refusedApplicationId, adminId, adminEmail, ts, ts);
      const refusal = await api(`/api/admin/applications/${refusedApplicationId}`, { method: 'DELETE', cookie });
      expect(refusal.status).toBe(200);
      expect(db.prepare('SELECT status FROM users WHERE id = ?').get(adminId)).toEqual({ status: 'active' });
    } finally {
      const candidate = db.prepare('SELECT id FROM users WHERE email = ?').get(candidateEmail) as { id: string } | undefined;
      if (candidate) db.prepare('DELETE FROM users WHERE id = ?').run(candidate.id);
      db.prepare('DELETE FROM audit_logs WHERE entity_id IN (?, ?, ?)').run(approvedApplicationId, selfApplicationId, refusedApplicationId);
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(adminId);
      db.prepare('DELETE FROM users WHERE id = ?').run(adminId);
    }
  });

  it('reports unread support replies for the client assistance badge', async () => {
    const client = db.prepare("SELECT id FROM users WHERE email = 'claire@maison-astralis.demo'").get() as { id: string };
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const ticketId = uuid();
    const ts = new Date().toISOString();
    const cookie = `astralis_session=${signSessionToken(client.id)}`;
    db.prepare(`
      INSERT INTO support_tickets (id, user_id, category, priority, status, subject, created_at, updated_at)
      VALUES (?, ?, 'account', 'normal', 'in_progress', 'Unread reply test', ?, ?)
    `).run(ticketId, client.id, ts, ts);
    db.prepare(`
      INSERT INTO support_messages (id, ticket_id, sender_id, is_staff, content, created_at, is_read)
      VALUES (?, ?, ?, 1, 'Support replied', ?, 0)
    `).run(uuid(), ticketId, admin.id, ts);

    try {
      const inbox = await api('/api/client/support/inbox', { cookie });
      expect(inbox.data.tickets).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ticketId, unread_count: 1 }),
      ]));
    } finally {
      db.prepare('DELETE FROM support_tickets WHERE id = ?').run(ticketId);
    }
  });

  it('permanently deletes archived support requests only and cascades their messages', async () => {
    const client = db.prepare("SELECT id FROM users WHERE email = 'claire@maison-astralis.demo'").get() as { id: string };
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const adminCookie = `astralis_session=${signSessionToken(admin.id)}`;
    const ts = new Date().toISOString();
    const activeId = uuid();
    const supportId = uuid();
    const contactId = uuid();

    db.prepare(`
      INSERT INTO support_tickets (id, user_id, category, priority, status, subject, created_at, updated_at)
      VALUES (?, ?, 'account', 'normal', 'open', 'Active request', ?, ?)
    `).run(activeId, client.id, ts, ts);
    db.prepare(`
      INSERT INTO support_tickets (id, user_id, category, priority, status, subject, created_at, updated_at, archived_at)
      VALUES (?, ?, 'account', 'normal', 'closed', 'Archived support', ?, ?, ?)
    `).run(supportId, client.id, ts, ts, ts);
    db.prepare(`
      INSERT INTO support_messages (id, ticket_id, sender_id, is_staff, content, created_at)
      VALUES (?, ?, ?, 1, 'Support reply', ?)
    `).run(uuid(), supportId, admin.id, ts);
    db.prepare(`
      INSERT INTO contact_messages (id, name, email, subject, message, status, created_at, updated_at, archived_at, user_id)
      VALUES (?, 'Client', 'client@example.test', 'Archived contact', 'Contact request', 'closed', ?, ?, ?, ?)
    `).run(contactId, ts, ts, ts, client.id);
    db.prepare(`
      INSERT INTO contact_message_replies (id, contact_message_id, sender_id, is_staff, content, created_at)
      VALUES (?, ?, ?, 1, 'Contact reply', ?)
    `).run(uuid(), contactId, admin.id, ts);

    try {
      const activeDelete = await api(`/api/admin/support/support/${activeId}/permanent`, {
        method: 'DELETE',
        cookie: adminCookie,
      });
      expect(activeDelete.status).toBe(409);
      expect(db.prepare('SELECT id FROM support_tickets WHERE id = ?').get(activeId)).toEqual({ id: activeId });

      const supportDelete = await api(`/api/admin/support/support/${supportId}/permanent`, {
        method: 'DELETE',
        cookie: adminCookie,
      });
      expect(supportDelete.status).toBe(200);
      expect(db.prepare('SELECT id FROM support_tickets WHERE id = ?').get(supportId)).toBeUndefined();
      expect(db.prepare('SELECT id FROM support_messages WHERE ticket_id = ?').all(supportId)).toHaveLength(0);

      const contactDelete = await api(`/api/admin/support/contact/${contactId}/permanent`, {
        method: 'DELETE',
        cookie: adminCookie,
      });
      expect(contactDelete.status).toBe(200);
      expect(db.prepare('SELECT id FROM contact_messages WHERE id = ?').get(contactId)).toBeUndefined();
      expect(db.prepare('SELECT id FROM contact_message_replies WHERE contact_message_id = ?').all(contactId)).toHaveLength(0);
    } finally {
      db.prepare('DELETE FROM support_tickets WHERE id IN (?, ?)').run(activeId, supportId);
      db.prepare('DELETE FROM contact_messages WHERE id = ?').run(contactId);
      db.prepare("DELETE FROM audit_logs WHERE action = 'admin.support_permanently_deleted' AND entity_id IN (?, ?)").run(supportId, contactId);
    }
  });

  it('marks client notifications as read when requested from the account header', async () => {
    const client = db.prepare("SELECT id FROM users WHERE email = 'claire@maison-astralis.demo'").get() as { id: string };
    const notificationId = uuid();
    const cookie = `astralis_session=${signSessionToken(client.id)}`;
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, is_read, created_at)
      VALUES (?, ?, 'test', 'Test notification', 'Unread notification', 0, ?)
    `).run(notificationId, client.id, new Date().toISOString());

    try {
      const unread = await api('/api/client/notifications', { cookie });
      expect(unread.data.notifications.find((notification: { id: string }) => notification.id === notificationId).is_read).toBe(0);

      const markedRead = await api('/api/client/notifications/read-all', { method: 'POST', cookie });
      expect(markedRead.status).toBe(200);
      expect(db.prepare('SELECT is_read FROM notifications WHERE id = ?').get(notificationId)).toEqual({ is_read: 1 });
    } finally {
      db.prepare('DELETE FROM notifications WHERE id = ?').run(notificationId);
    }
  });

  it('restores deleted development demo accounts and their advertised credentials', async () => {
    const previousAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = 'test';
    const client = db.prepare(`
      SELECT id, status, deleted_at, password_hash
      FROM users WHERE email = 'claire@maison-astralis.demo'
    `).get() as { id: string; status: string; deleted_at: string | null; password_hash: string };
    const expert = db.prepare(`
      SELECT u.id, u.status, u.deleted_at, u.password_hash, ep.status AS profile_status, ep.presence_status
      FROM users u
      JOIN expert_profiles ep ON ep.user_id = u.id
      WHERE u.email = 'celeste@maison-astralis.demo'
    `).get() as {
      id: string;
      status: string;
      deleted_at: string | null;
      password_hash: string;
      profile_status: string;
      presence_status: string;
    };
    const ts = new Date().toISOString();

    try {
      db.prepare("UPDATE users SET status = 'deleted', deleted_at = ?, password_hash = 'stale' WHERE id IN (?, ?)")
        .run(ts, client.id, expert.id);
      db.prepare("UPDATE expert_profiles SET status = 'suspended', presence_status = 'offline' WHERE user_id = ?")
        .run(expert.id);

      initDatabase();

      const restoredClient = db.prepare('SELECT status, deleted_at, password_hash FROM users WHERE id = ?')
        .get(client.id) as { status: string; deleted_at: string | null; password_hash: string };
      const restoredExpert = db.prepare('SELECT status, deleted_at, password_hash FROM users WHERE id = ?')
        .get(expert.id) as { status: string; deleted_at: string | null; password_hash: string };
      expect(restoredClient.status).toBe('active');
      expect(restoredClient.deleted_at).toBeNull();
      expect(verifyPassword('AstralisClient2026!', restoredClient.password_hash)).toBe(true);
      expect(restoredExpert.status).toBe('active');
      expect(restoredExpert.deleted_at).toBeNull();
      expect(verifyPassword('AstralisExpert2026!', restoredExpert.password_hash)).toBe(true);
      expect(db.prepare('SELECT status, presence_status FROM expert_profiles WHERE user_id = ?').get(expert.id))
        .toEqual({ status: 'approved', presence_status: 'online' });
    } finally {
      db.prepare('UPDATE users SET status = ?, deleted_at = ?, password_hash = ? WHERE id = ?')
        .run(client.status, client.deleted_at, client.password_hash, client.id);
      db.prepare('UPDATE users SET status = ?, deleted_at = ?, password_hash = ? WHERE id = ?')
        .run(expert.status, expert.deleted_at, expert.password_hash, expert.id);
      db.prepare('UPDATE expert_profiles SET status = ?, presence_status = ? WHERE user_id = ?')
        .run(expert.profile_status, expert.presence_status, expert.id);
      if (previousAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
    }
  });

  it('keeps only one featured expert in the home page at a time', async () => {
    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    expect(adminLogin.status).toBe(200);
    const adminCookie = adminLogin.setCookie!.split(';')[0];
    const featuredBefore = db.prepare('SELECT id FROM expert_profiles WHERE is_featured = 1 ORDER BY display_name').all() as Array<{ id: string }>;
    const approvedExperts = db.prepare("SELECT id FROM expert_profiles WHERE status = 'approved' ORDER BY display_name LIMIT 2").all() as Array<{ id: string }>;
    const firstExpertId = approvedExperts[0]?.id;
    const secondExpertId = approvedExperts[1]?.id;
    expect(firstExpertId).toBeDefined();
    expect(secondExpertId).toBeDefined();

    try {
      const setFirst = await api(`/api/admin/experts/${firstExpertId}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ isFeatured: true }),
      });
      expect(setFirst.status).toBe(200);
      expect((db.prepare('SELECT COUNT(*) as count FROM expert_profiles WHERE is_featured = 1').get() as { count: number }).count).toBe(1);

      const setSecond = await api(`/api/admin/experts/${secondExpertId}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ isFeatured: true }),
      });
      expect(setSecond.status).toBe(200);
      const featuredAfterToggle = db.prepare('SELECT id FROM expert_profiles WHERE is_featured = 1').all() as Array<{ id: string }>;
      expect(featuredAfterToggle).toHaveLength(1);
      expect(featuredAfterToggle[0].id).toBe(secondExpertId);

      const removeFeatured = await api(`/api/admin/experts/${secondExpertId}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ isFeatured: false }),
      });
      expect(removeFeatured.status).toBe(200);
      expect((db.prepare('SELECT COUNT(*) as count FROM expert_profiles WHERE is_featured = 1').get() as { count: number }).count).toBe(0);
    } finally {
      db.prepare('UPDATE expert_profiles SET is_featured = 0 WHERE is_featured = 1').run();
      for (const entry of featuredBefore) {
        db.prepare('UPDATE expert_profiles SET is_featured = 1 WHERE id = ?').run(entry.id);
      }
    }
  });

  it('lets admins delete non-admin user accounts without removing their history', async () => {
    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = adminLogin.setCookie!.split(';')[0];
    const ticketsBefore = await api('/api/admin/overview', { cookie: adminCookie });
    const contactEmail = `contact-${uuid()}@example.test`;
    const contactSubject = `Question ${uuid()}`;
    const contactSubmission = await api('/api/public/contact', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Camille Contact',
        email: contactEmail,
        subject: contactSubject,
        message: 'Bonjour, pouvez-vous m’aider avec ma réservation ?',
      }),
    });
    expect(contactSubmission.status).toBe(201);
    const supportQueue = await api('/api/admin/support', { cookie: adminCookie });
    const contactTicket = supportQueue.data.tickets.find((ticket: Record<string, unknown>) => ticket.subject === contactSubject);
    expect(contactTicket).toMatchObject({
      user_email: contactEmail,
      contact_name: 'Camille Contact',
      message: 'Bonjour, pouvez-vous m’aider avec ma réservation ?',
      status: 'in_progress',
      source: 'contact',
      unread_count: 1,
    });
    const adminContent = await api('/api/admin/content', { cookie: adminCookie });
    expect(adminContent.data.tickets.find((ticket: Record<string, unknown>) => ticket.id === contactTicket.id))
      .toMatchObject({ contact_name: 'Camille Contact', message: 'Bonjour, pouvez-vous m’aider avec ma réservation ?' });
    const ticketsAfterSubmission = await api('/api/admin/overview', { cookie: adminCookie });
    expect(ticketsAfterSubmission.data.openTickets).toBe(ticketsBefore.data.openTickets + 1);
    expect(ticketsAfterSubmission.data.unreadSupportMessages).toBe(ticketsBefore.data.unreadSupportMessages + 1);
    const contactThread = await api(`/api/admin/support/contact/${contactTicket.id}/messages`, { cookie: adminCookie });
    expect(contactThread.data.messages).toHaveLength(1);
    expect(contactThread.data.messages[0]).toMatchObject({ content: 'Bonjour, pouvez-vous m’aider avec ma réservation ?', is_staff: 0 });
    const contactReply = await api(`/api/admin/support/contact/${contactTicket.id}/messages`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ content: 'Nous avons vérifié votre demande.' }),
    });
    expect(contactReply.status).toBe(201);
    expect(contactReply.data).toMatchObject({ ok: true, delivery: 'in_app' });
    const contactThreadAfterReply = await api(`/api/admin/support/contact/${contactTicket.id}/messages`, { cookie: adminCookie });
    expect(contactThreadAfterReply.data.messages[1]).toMatchObject({
      content: 'Nous avons vérifié votre demande.',
    });
    expect(db.prepare('SELECT email_delivery_status FROM contact_message_replies WHERE contact_message_id = ? AND is_staff = 1')
      .get(contactTicket.id)).toEqual({ email_delivery_status: 'in_app' });
    const contactResolution = await api(`/api/admin/support/contact/${contactTicket.id}/status`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'resolved' }),
    });
    expect(contactResolution.status).toBe(200);
    expect((await api('/api/admin/support', { cookie: adminCookie })).data.tickets.find(
      (ticket: Record<string, unknown>) => ticket.id === contactTicket.id
    )    ).toMatchObject({ status: 'resolved' });
    expect((await api('/api/admin/overview', { cookie: adminCookie })).data.openTickets)
      .toBe(ticketsBefore.data.openTickets);
    const contactThreadAfterResolution = await api(`/api/admin/support/contact/${contactTicket.id}/messages`, { cookie: adminCookie });
    expect(contactThreadAfterResolution.data.messages[2]).toMatchObject({
      content: 'Votre demande a été marquée comme résolue par notre équipe',
      is_staff: 1,
    });
    const archivedContact = await api(`/api/admin/support/contact/${contactTicket.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(archivedContact.data).toMatchObject({ ok: true, archived: true });
    expect((await api('/api/admin/support', { cookie: adminCookie })).data.tickets)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: contactTicket.id })]));
    expect((await api('/api/admin/support?archived=true', { cookie: adminCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: contactTicket.id, archived_at: expect.any(String) })]));
    const restoreContact = await api(`/api/admin/support/contact/${contactTicket.id}/restore`, {
      method: 'POST',
      cookie: adminCookie,
    });
    expect(restoreContact.data).toMatchObject({ ok: true, archived: false });

    const selfSuspend = await api(`/api/admin/users/${adminLogin.data.user.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(selfSuspend.status).toBe(409);
    const userId = uuid();
    const email = `delete-target-${userId}@example.test`;
    const lastSeen = new Date(Date.now() - 60_000).toISOString();
    const overviewBefore = await api(`/api/admin/overview?usersSince=${encodeURIComponent(lastSeen)}`, { cookie: adminCookie });
    const ts = new Date().toISOString();
    const demoClientId = uuid();
    try {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at)
        VALUES (?, ?, 'unused', 'active', 0, 1, ?, ?)
      `).run(demoClientId, `demo-client-${demoClientId}@example.test`, ts, ts);
      db.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(uuid(), demoClientId, 'client', ts);
      const overviewWithDemoClient = await api('/api/admin/overview', { cookie: adminCookie });
      expect(overviewWithDemoClient.data.totalClients).toBe(overviewBefore.data.totalClients);
    } finally {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(demoClientId);
      db.prepare('DELETE FROM users WHERE id = ?').run(demoClientId);
    }

    db.prepare(`
      INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at)
      VALUES (?, ?, 'unused', 'active', 0, 0, ?, ?)
    `).run(userId, email, ts, ts);
    db.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(uuid(), userId, 'client', ts);
    db.prepare(`
      INSERT INTO client_profiles (user_id, first_name, last_name, phone, created_at, updated_at)
      VALUES (?, 'Camille', 'Martin', '+33612345678', ?, ?)
    `).run(userId, ts, ts);
    db.prepare('INSERT INTO wallets (user_id, available_cents, pending_cents, currency, updated_at) VALUES (?, 1250, 0, ?, ?)')
      .run(userId, 'EUR', ts);

    const overviewAfter = await api(`/api/admin/overview?usersSince=${encodeURIComponent(lastSeen)}`, { cookie: adminCookie });
    expect(overviewAfter.data.newUsers).toBe(overviewBefore.data.newUsers + 1);
    expect(overviewAfter.data.totalClients).toBe(overviewBefore.data.totalClients + 1);
    const suspended = await api(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(suspended.status).toBe(200);
    const listedUser = await api(`/api/admin/users?q=${encodeURIComponent(email)}`, { cookie: adminCookie });
    expect(listedUser.data.users[0]).toMatchObject({
      first_name: 'Camille',
      last_name: 'Martin',
      phone: '+33612345678',
      roles_csv: 'client',
      status: 'suspended',
    });
    const reactivated = await api(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'active' }),
    });
    expect(reactivated.status).toBe(200);
    expect((await api(`/api/admin/users?q=${encodeURIComponent(email)}`, { cookie: adminCookie })).data.users[0])
      .toMatchObject({ status: 'active', first_name: 'Camille', last_name: 'Martin', phone: '+33612345678' });

    const protectedAdminId = uuid();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at)
      VALUES (?, ?, 'unused', 'active', 0, 0, ?, ?)
    `).run(protectedAdminId, `protected-admin-${protectedAdminId}@example.test`, ts, ts);
    db.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(uuid(), protectedAdminId, 'admin', ts);

    const selfDelete = await api(`/api/admin/users/${adminLogin.data.user.id}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(selfDelete.status).toBe(409);

    const adminDelete = await api(`/api/admin/users/${protectedAdminId}`, { method: 'DELETE', cookie: adminCookie });
    expect(adminDelete.status).toBe(409);

    const deletion = await api(`/api/admin/users/${userId}`, { method: 'DELETE', cookie: adminCookie });
    expect(deletion.status).toBe(200);
    expect(db.prepare('SELECT status, deleted_at FROM users WHERE id = ?').get(userId)).toMatchObject({
      status: 'deleted',
      deleted_at: expect.any(String),
    });
    expect(db.prepare('SELECT available_cents FROM wallets WHERE user_id = ?').get(userId)).toEqual({ available_cents: 1250 });
    expect((await api(`/api/admin/users?q=${encodeURIComponent(email)}`, { cookie: adminCookie })).data.users).toHaveLength(0);
    expect((await api('/api/admin/overview', { cookie: adminCookie })).data.totalClients).toBe(overviewBefore.data.totalClients);
    expect((await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'unused' }),
    })).status).toBe(401);
  });

  it('delivers status messages, preserves each selected status, and locks only resolved or closed client conversations', async () => {
    const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const adminCookie = `astralis_session=${signSessionToken(adminUser.id)}`;
    const email = `status-client-${uuid()}@example.test`;
    const registration = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'SupportPass2026!',
        firstName: 'Camille',
        lastName: 'Status',
        phone: '+33123456789',
        termsAccepted: true,
      }),
    });
    expect(registration.status).toBe(201);
    const clientCookie = registration.setCookie!.split(';')[0];

    for (const source of ['support', 'contact'] as const) {
      for (const action of ['in_progress', 'resolved', 'closed'] as const) {
        const subject = `Status ${source} ${action} ${uuid()}`;
        let ticketId: string;
        if (source === 'support') {
          const createdTicket = await api('/api/client/support', {
            method: 'POST',
            cookie: clientCookie,
            body: JSON.stringify({
              subject,
              category: 'account',
              message: 'Je demande une vérification concernant mon compte.',
            }),
          });
          expect(createdTicket.status).toBe(201);
          ticketId = createdTicket.data.ticketId as string;
        } else {
          const createdContact = await api('/api/public/contact', {
            method: 'POST',
            cookie: clientCookie,
            body: JSON.stringify({
              name: 'Camille Status',
              email,
              subject,
              message: 'Je demande une vérification concernant mon compte.',
            }),
          });
          expect(createdContact.status).toBe(201);
          ticketId = (db.prepare('SELECT id FROM contact_messages WHERE subject = ?')
            .get(subject) as { id: string }).id;
        }

        const openTicket = await api(`/api/admin/support/${source}/${ticketId}/status`, {
          method: 'PATCH',
          cookie: adminCookie,
          body: JSON.stringify({ status: 'open' }),
        });
        expect(openTicket.data).toMatchObject({ ok: true, status: 'open' });

        const statusResponse = await api(`/api/admin/support/${source}/${ticketId}/status`, {
          method: 'PATCH',
          cookie: adminCookie,
          body: JSON.stringify({ status: action }),
        });
        expect(statusResponse.status).toBe(200);
        expect(statusResponse.data).toMatchObject({ ok: true, status: action, delivery: 'in_app' });

        const clientInbox = await api('/api/client/support/inbox', { cookie: clientCookie });
        expect(clientInbox.data.tickets).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: ticketId, status: action, has_staff_reply: 0 }),
        ]));
        const adminThread = await api(`/api/admin/support/${source}/${ticketId}/messages`, { cookie: adminCookie });
        const lastMessage = adminThread.data.messages[adminThread.data.messages.length - 1];
        expect(lastMessage).toMatchObject({ content: SUPPORT_STATUS_MESSAGES[action], is_staff: 1 });

        const replyRoute = source === 'support'
          ? `/api/client/support/${ticketId}/messages`
          : `/api/client/support/contact/${ticketId}/messages`;
        const replyAfterStatus = await api(replyRoute, {
          method: 'POST',
          cookie: clientCookie,
          body: JSON.stringify({ content: 'Je souhaite répondre après la clôture.' }),
        });
        expect(replyAfterStatus.status).toBe(409);

        const adminReply = await api(`/api/admin/support/${source}/${ticketId}/messages`, {
          method: 'POST',
          cookie: adminCookie,
          body: JSON.stringify({ content: 'Un membre du support vous répond.' }),
        });
        expect(adminReply.status).toBe(201);
        const afterAdminReply = await api('/api/client/support/inbox', { cookie: clientCookie });
        expect(afterAdminReply.data.tickets).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: ticketId,
            status: action === 'in_progress' ? 'waiting_customer' : action,
            has_staff_reply: 1,
          }),
        ]));
        const replyAfterHumanResponse = await api(replyRoute, {
          method: 'POST',
          cookie: clientCookie,
          body: JSON.stringify({ content: 'Merci pour votre réponse.' }),
        });
        expect(replyAfterHumanResponse.status).toBe(action === 'in_progress' ? 201 : 409);
      }
    }
  });

  it('unlocks client replies after the first support response and keeps tickets readable until then', async () => {
    const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const adminCookie = `astralis_session=${signSessionToken(adminUser.id)}`;
    const email = `support-client-${uuid()}@example.test`;
    const registration = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'SupportPass2026!',
        firstName: 'Camille',
        lastName: 'Support',
        phone: '+33123456789',
        termsAccepted: true,
      }),
    });
    expect(registration.status).toBe(201);
    const clientCookie = registration.setCookie!.split(';')[0];
    const linkedContactSubject = `Contact utilisateur ${uuid()}`;
    const linkedContact = await api('/api/public/contact', {
      method: 'POST',
      cookie: clientCookie,
      body: JSON.stringify({
        name: 'Camille Support',
        email,
        subject: linkedContactSubject,
        message: 'Je vous contacte depuis mon compte client.',
      }),
    });
    expect(linkedContact.status).toBe(201);
    const linkedContactId = (db.prepare('SELECT id FROM contact_messages WHERE subject = ?')
      .get(linkedContactSubject) as { id: string }).id;
    expect(db.prepare('SELECT user_id FROM contact_messages WHERE id = ?').get(linkedContactId))
      .toEqual({ user_id: registration.data.user.id });
    expect((await api('/api/client/support/inbox', { cookie: clientCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: linkedContactId, status: 'in_progress' })]));
    const openContactTicket = await api(`/api/admin/support/contact/${linkedContactId}/status`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'open' }),
    });
    expect(openContactTicket.data).toMatchObject({ ok: true, status: 'open' });
    expect((await api('/api/client/support/inbox', { cookie: clientCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: linkedContactId, status: 'open', has_staff_reply: 0 })]));
    const earlyContactReply = await api(`/api/client/support/contact/${linkedContactId}/messages`, {
      method: 'POST',
      cookie: clientCookie,
      body: JSON.stringify({ content: 'Je souhaite ajouter une précision à ma demande.' }),
    });
    expect(earlyContactReply.status).toBe(409);
    const firstContactStaffReply = await api(`/api/admin/support/contact/${linkedContactId}/messages`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ content: 'Nous avons bien reçu votre demande.' }),
    });
    expect(firstContactStaffReply.status).toBe(201);
    expect((await api('/api/client/support/inbox', { cookie: clientCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: linkedContactId, has_staff_reply: 1 })]));
    const contactReplyAfterFirstResponse = await api(`/api/client/support/contact/${linkedContactId}/messages`, {
      method: 'POST',
      cookie: clientCookie,
      body: JSON.stringify({ content: 'Je souhaite ajouter une précision à ma demande.' }),
    });
    expect(contactReplyAfterFirstResponse.status).toBe(201);
    await api(`/api/client/support/contact/${linkedContactId}/messages`, { cookie: clientCookie });
    expect((await api('/api/client/support/inbox', { cookie: clientCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: linkedContactId, source: 'contact' })]));
    const invalidTicket = await api('/api/client/support', {
      method: 'POST',
      cookie: clientCookie,
      body: JSON.stringify({
        subject: '    ',
        category: 'account',
        message: '          ',
      }),
    });
    expect(invalidTicket.status).toBe(400);

    const ticketResponse = await api('/api/client/support', {
      method: 'POST',
      cookie: clientCookie,
      body: JSON.stringify({
        subject: 'Suivi de réservation',
        category: 'account',
        message: 'Je souhaite vérifier ma réservation de consultation.',
      }),
    });
    expect(ticketResponse.status).toBe(201);
    const ticketId = ticketResponse.data.ticketId as string;
    expect((await api('/api/client/support/inbox', { cookie: clientCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: ticketId, status: 'in_progress', has_staff_reply: 0 })]));
    const earlyClientReply = await api(`/api/client/support/${ticketId}/messages`, {
      method: 'POST',
      cookie: clientCookie,
      body: JSON.stringify({ content: 'Je souhaite ajouter une précision à ma demande.' }),
    });
    expect(earlyClientReply.status).toBe(409);
    expect((await api('/api/admin/support', { cookie: adminCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: ticketId, source: 'support' })]));
    const readableBeforeFirstResponse = await api(`/api/client/support/${ticketId}/messages`, { cookie: clientCookie });
    expect(readableBeforeFirstResponse.data.messages[0]).toMatchObject({
      content: 'Je souhaite vérifier ma réservation de consultation.',
      is_staff: 0,
    });
    const openSupportTicket = await api(`/api/admin/support/support/${ticketId}/status`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'open' }),
    });
    expect(openSupportTicket.data).toMatchObject({ ok: true, status: 'open' });
    expect((await api('/api/client/support/inbox', { cookie: clientCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: ticketId, status: 'open', has_staff_reply: 0 })]));
    const initialThread = await api(`/api/admin/support/support/${ticketId}/messages`, { cookie: adminCookie });
    expect(initialThread.data.messages).toHaveLength(1);
    expect(initialThread.data.messages[0]).toMatchObject({
      content: 'Je souhaite vérifier ma réservation de consultation.',
      is_staff: 0,
    });
    const adminReply = await api(`/api/admin/support/support/${ticketId}/messages`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ content: 'Votre réservation est confirmée.' }),
    });
    expect(adminReply.status).toBe(201);
    expect(adminReply.data).toMatchObject({ ok: true, delivery: 'in_app' });
    expect((await api('/api/client/support/inbox', { cookie: clientCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: ticketId, has_staff_reply: 1 })]));
    expect(db.prepare(`
      SELECT link_url FROM notifications
      WHERE user_id = ? AND type = 'support_reply'
      ORDER BY created_at DESC LIMIT 1
    `).get(registration.data.user.id)).toEqual({ link_url: '/account/support' });

    const clientInbox = await api('/api/client/support/inbox', { cookie: clientCookie });
    const clientTicket = clientInbox.data.tickets.find((ticket: Record<string, unknown>) => ticket.id === ticketId);
    expect(clientTicket).toMatchObject({ source: 'support', unread_count: 1 });
    const clientThread = await api(`/api/client/support/${ticketId}/messages`, { cookie: clientCookie });
    expect(clientThread.data.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Votre réservation est confirmée.', is_staff: 1 }),
    ]));
    expect((await api('/api/client/dashboard', { cookie: clientCookie })).data.unreadMessages).toBe(0);

    const clientReply = await api(`/api/client/support/${ticketId}/messages`, {
      method: 'POST',
      cookie: clientCookie,
      body: JSON.stringify({ content: 'Merci pour la confirmation.' }),
    });
    expect(clientReply.status).toBe(201);
    const adminOverviewBeforeRead = await api('/api/admin/overview', { cookie: adminCookie });
    expect(adminOverviewBeforeRead.data.unreadSupportMessages).toBeGreaterThan(0);
    await api(`/api/admin/support/support/${ticketId}/messages`, { cookie: adminCookie });
    expect(db.prepare('SELECT email_delivery_status FROM support_messages WHERE ticket_id = ? AND is_staff = 1')
      .get(ticketId)).toEqual({ email_delivery_status: 'in_app' });

    const closeTicket = await api(`/api/admin/support/support/${ticketId}/status`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'closed' }),
    });
    expect(closeTicket.status).toBe(200);
    expect(closeTicket.data.status).toBe('closed');
    expect((await api(`/api/client/support/inbox`, { cookie: clientCookie })).data.tickets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: ticketId, status: 'closed' })]));
    const closedThread = await api(`/api/admin/support/support/${ticketId}/messages`, { cookie: adminCookie });
    expect(closedThread.data.messages[closedThread.data.messages.length - 1]).toMatchObject({
      content: 'Votre demande a été clôturée par notre équipe',
      is_staff: 1,
    });
    const replyAfterClose = await api(`/api/client/support/${ticketId}/messages`, {
      method: 'POST',
      cookie: clientCookie,
      body: JSON.stringify({ content: 'Je ne peux plus répondre à ce ticket.' }),
    });
    expect(replyAfterClose.status).toBe(409);
  });

  it('rejects demo account credentials in production', async () => {
    const previousAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      const login = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'claire@maison-astralis.demo', password: 'AstralisClient2026!' }),
      });
      expect(login.status).toBe(401);
    } finally {
      if (previousAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
    }
  });

  it('disables already-seeded demo accounts when production starts', () => {
    const demoUsers = db.prepare('SELECT id, status, deleted_at FROM users WHERE is_demo = 1').all() as Array<{
      id: string;
      status: string;
      deleted_at: string | null;
    }>;
    const demoExperts = db.prepare('SELECT id, status, presence_status FROM expert_profiles WHERE is_demo = 1').all() as Array<{
      id: string;
      status: string;
      presence_status: string;
    }>;
    const previousAppEnv = process.env.APP_ENV;

    process.env.APP_ENV = 'production';
    try {
      initDatabase();
      expect(db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_demo = 1 AND status != 'deleted'").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM expert_profiles WHERE is_demo = 1 AND (status != 'suspended' OR presence_status != 'offline')").get())
        .toEqual({ count: 0 });
    } finally {
      const restore = db.transaction(() => {
        const updateUser = db.prepare('UPDATE users SET status = ?, deleted_at = ? WHERE id = ?');
        demoUsers.forEach((user) => updateUser.run(user.status, user.deleted_at, user.id));
        const updateExpert = db.prepare('UPDATE expert_profiles SET status = ?, presence_status = ? WHERE id = ?');
        demoExperts.forEach((expert) => updateExpert.run(expert.status, expert.presence_status, expert.id));
      });
      restore();
      if (previousAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
    }
  });

  it('restricts expert application records and decisions to administrators', async () => {
    const staffId = uuid();
    const staffEmail = `staff-${staffId}@example.test`;
    const ts = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, email, password_hash, status, email_verified, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0, 0, ?, ?)
    `).run(staffId, staffEmail, hashPassword('StaffTestPass2026!'), ts, ts);
    db.prepare('INSERT INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(uuid(), staffId, 'staff', ts);

    const staffLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: staffEmail, password: 'StaffTestPass2026!' }),
    });
    expect(staffLogin.status).toBe(200);
    const staffCookie = staffLogin.setCookie!.split(';')[0];

    expect((await api('/api/admin/applications', { cookie: staffCookie })).status).toBe(403);
    expect((await api(`/api/admin/applications/${uuid()}`, {
      method: 'PATCH',
      cookie: staffCookie,
      body: JSON.stringify({ status: 'rejected' }),
    })).status).toBe(403);
    expect((await api(`/api/admin/applications/${uuid()}`, {
      method: 'DELETE',
      cookie: staffCookie,
    })).status).toBe(403);
  });

  it('lets admins upload and remove one expert avatar without affecting other profiles', async () => {
    const expert = db.prepare("SELECT id, avatar_url FROM expert_profiles WHERE slug = 'marcus-vance'").get() as {
      id: string;
      avatar_url: string | null;
    };
    const otherExpert = db.prepare("SELECT avatar_url FROM expert_profiles WHERE slug = 'celeste-moreau'").get() as {
      avatar_url: string | null;
    };
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';

    const unauthorized = await api(`/api/admin/experts/${expert.id}/avatar`, {
      method: 'POST',
      body: JSON.stringify({ imageDataUrl }),
    });
    expect(unauthorized.status).toBe(401);

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = login.setCookie!.split(';')[0];
    const upload = await api(`/api/admin/experts/${expert.id}/avatar`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ imageDataUrl }),
    });
    expect(upload.status).toBe(200);
    expect(upload.data.avatarUrl).toMatch(/^\/uploads\/expert-avatars\/.+\.png$/);
    const served = await fetch(`${baseUrl}${upload.data.avatarUrl}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(8);

    const profile = await api('/api/public/experts/marcus-vance');
    expect(profile.data.expert.avatar_url).toBe(upload.data.avatarUrl);
    expect(db.prepare("SELECT avatar_url FROM expert_profiles WHERE slug = 'celeste-moreau'").get()).toEqual(otherExpert);

    const invalidImage = await api(`/api/admin/experts/${expert.id}/avatar`, {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ imageDataUrl: 'data:image/png;base64,SGVsbG8=' }),
    });
    expect(invalidImage.status).toBe(400);

    const removal = await api(`/api/admin/experts/${expert.id}/avatar`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(removal.status).toBe(200);
    expect(db.prepare('SELECT avatar_url FROM expert_profiles WHERE id = ?').get(expert.id)).toEqual({ avatar_url: null });
    expect((await fetch(`${baseUrl}${upload.data.avatarUrl}`)).status).toBe(404);
  });

  it('lets admins set a safe external chat link for one expert profile', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    expect(login.status).toBe(200);
    const adminCookie = login.setCookie!.split(';')[0];
    const expert = db.prepare("SELECT id FROM expert_profiles WHERE slug = 'marcus-vance'").get() as { id: string };
    const externalChatUrl = 'https://example.com/marcus-chat';

    const update = await api(`/api/admin/experts/${expert.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ externalChatUrl }),
    });
    expect(update.status).toBe(200);

    const profile = await api('/api/public/experts/marcus-vance');
    expect(profile.data.expert.external_chat_url).toBe(externalChatUrl);

    const unsafeUpdate = await api(`/api/admin/experts/${expert.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ externalChatUrl: 'javascript:alert(1)' }),
    });
    expect(unsafeUpdate.status).toBe(400);

    await api(`/api/admin/experts/${expert.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ externalChatUrl: null }),
    });
  });

  it('lets admins override and restore homepage statistics', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const adminCookie = `astralis_session=${signSessionToken(admin.id)}`;
    const original = db.prepare("SELECT value_json FROM platform_settings WHERE key = 'homepage_stats'").get() as
      | { value_json: string }
      | undefined;
    const liveStats = (await api('/api/public/stats')).data;

    try {
      const update = await api('/api/admin/settings', {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({
          key: 'homepage_stats',
          value: { verifiedExperts: 7, completedConsultations: 42, publishedReviews: 18 },
        }),
      });
      expect(update.status).toBe(200);
      expect((await api('/api/public/stats')).data).toMatchObject({
        verifiedExperts: 7,
        completedConsultations: 42,
        publishedReviews: 18,
        includesDemoData: false,
      });

      const invalid = await api('/api/admin/settings', {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({
          key: 'homepage_stats',
          value: { verifiedExperts: -1, completedConsultations: 42, publishedReviews: 18 },
        }),
      });
      expect(invalid.status).toBe(400);

      const reset = await api('/api/admin/settings', {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({
          key: 'homepage_stats',
          value: { verifiedExperts: null, completedConsultations: null, publishedReviews: null },
        }),
      });
      expect(reset.status).toBe(200);
      expect((await api('/api/public/stats')).data).toMatchObject({
        verifiedExperts: liveStats.verifiedExperts,
        completedConsultations: liveStats.completedConsultations,
        publishedReviews: liveStats.publishedReviews,
      });
    } finally {
      if (original) {
        db.prepare(`
          UPDATE platform_settings SET value_json = ? WHERE key = 'homepage_stats'
        `).run(original.value_json);
      } else {
        db.prepare("DELETE FROM platform_settings WHERE key = 'homepage_stats'").run();
      }
    }
  });

  it('lets admins override and reset an expert rating and review count', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = login.setCookie!.split(';')[0];
    const expert = db.prepare("SELECT id, slug FROM expert_profiles WHERE slug = 'celeste-moreau'").get() as {
      id: string;
      slug: string;
    };
    const storedStats = db.prepare('SELECT rating_avg_bp, review_count FROM expert_profiles WHERE id = ?').get(expert.id) as {
      rating_avg_bp: number;
      review_count: number;
    };

    const update = await api(`/api/admin/experts/${expert.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ ratingOverrideBp: 437, reviewCountOverride: 1234 }),
    });
    expect(update.status).toBe(200);

    const profile = await api(`/api/public/experts/${expert.slug}`);
    expect(profile.data.expert.rating_avg_bp).toBe(437);
    expect(profile.data.expert.review_count).toBe(1234);

    const catalog = await api('/api/public/experts?limit=24');
    const catalogExpert = catalog.data.items.find((item: { slug: string }) => item.slug === expert.slug);
    expect(catalogExpert.rating_avg_bp).toBe(437);
    expect(catalogExpert.review_count).toBe(1234);

    const invalidUpdate = await api(`/api/admin/experts/${expert.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ ratingOverrideBp: 501, reviewCountOverride: -1 }),
    });
    expect(invalidUpdate.status).toBe(400);

    const reset = await api(`/api/admin/experts/${expert.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ ratingOverrideBp: null, reviewCountOverride: null }),
    });
    expect(reset.status).toBe(200);
    const resetProfile = await api(`/api/public/experts/${expert.slug}`);
    expect(resetProfile.data.expert.rating_avg_bp).toBe(storedStats.rating_avg_bp);
    expect(resetProfile.data.expert.review_count).toBe(storedStats.review_count);
  });

  it('lets admins edit the experience and consultation counts shown on expert profiles', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const adminCookie = `astralis_session=${signSessionToken(admin.id)}`;
    const expert = db.prepare(`
      SELECT id, slug, years_experience, completed_consultations
      FROM expert_profiles WHERE slug = 'celeste-moreau'
    `).get() as {
      id: string;
      slug: string;
      years_experience: number;
      completed_consultations: number;
    };

    try {
      const update = await api(`/api/admin/experts/${expert.id}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ yearsExperience: 44, completedConsultations: 128 }),
      });
      expect(update.status).toBe(200);
      const profile = await api(`/api/public/experts/${expert.slug}`);
      expect(profile.data.expert).toMatchObject({
        years_experience: 44,
        completed_consultations: 128,
      });

      const invalid = await api(`/api/admin/experts/${expert.id}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ completedConsultations: -1 }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      await api(`/api/admin/experts/${expert.id}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({
          yearsExperience: expert.years_experience,
          completedConsultations: expert.completed_consultations,
        }),
      });
    }
  });

  it('creates experts suspended by default and lets admins set their availability mode', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const adminCookie = `astralis_session=${signSessionToken(admin.id)}`;
    let expertId: string | null = null;

    try {
      const create = await api('/api/admin/experts', {
        method: 'POST',
        cookie: adminCookie,
        body: JSON.stringify({
          displayName: `Mode Test ${Date.now()}`,
          presenceStatus: 'online',
        }),
      });
      expect(create.status).toBe(201);
      expertId = create.data.expertId;

      const stored = db.prepare(`
        SELECT ep.status, ep.presence_status, u.status AS user_status
        FROM expert_profiles ep JOIN users u ON u.id = ep.user_id
        WHERE ep.id = ?
      `).get(expertId) as { status: string; presence_status: string; user_status: string };
      expect(stored).toEqual({ status: 'suspended', presence_status: 'online', user_status: 'suspended' });
      expect((await api(`/api/public/experts/${create.data.slug}`)).status).toBe(404);

      const approve = await api(`/api/admin/experts/${expertId}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ status: 'approved' }),
      });
      expect(approve.status).toBe(200);
      const publicProfile = await api(`/api/public/experts/${create.data.slug}`);
      expect(publicProfile.data.expert.presence_status).toBe('online');

      const setAppointmentMode = await api(`/api/admin/experts/${expertId}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ presenceStatus: 'offline' }),
      });
      expect(setAppointmentMode.status).toBe(200);
      expect((await api(`/api/public/experts/${create.data.slug}`)).data.expert.presence_status).toBe('offline');

      const invalidMode = await api(`/api/admin/experts/${expertId}`, {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ presenceStatus: 'appointment' }),
      });
      expect(invalidMode.status).toBe(400);
    } finally {
      if (expertId) {
        await api(`/api/admin/experts/${expertId}`, {
          method: 'DELETE',
          cookie: adminCookie,
        });
      }
    }
  });

  it('omits deleted expert accounts from the admin list used by reviews', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const adminCookie = `astralis_session=${signSessionToken(admin.id)}`;
    const expert = db.prepare(`
      SELECT ep.id AS expert_id, u.id AS user_id, u.status, u.deleted_at
      FROM expert_profiles ep
      JOIN users u ON u.id = ep.user_id
      WHERE ep.slug = 'marcus-vance'
    `).get() as { expert_id: string; user_id: string; status: string; deleted_at: string | null };

    try {
      db.prepare("UPDATE users SET status = 'deleted', deleted_at = ? WHERE id = ?")
        .run(new Date().toISOString(), expert.user_id);

      const response = await api('/api/admin/experts', { cookie: adminCookie });
      expect(response.status).toBe(200);
      expect(response.data.experts.some((entry: { id: string }) => entry.id === expert.expert_id)).toBe(false);
    } finally {
      db.prepare('UPDATE users SET status = ?, deleted_at = ? WHERE id = ?')
        .run(expert.status, expert.deleted_at, expert.user_id);
    }
  });

  it('creates usable expert accounts and removes them from the public marketplace', async () => {
    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = adminLogin.setCookie!.split(';')[0];

    const create = await api('/api/admin/experts', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ displayName: 'Liora Morel', specialty: 'Tarot', status: 'approved' }),
    });
    expect(create.status).toBe(201);
    expect(create.data.email).toMatch(/^liora-morel-.+@maison-astralis\.local$/);
    expect(create.data.temporaryPassword).toHaveLength(48);

    const expertLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: create.data.email,
        password: create.data.temporaryPassword,
      }),
    });
    expect(expertLogin.status).toBe(200);
    expect(expertLogin.data.user.roles).toContain('expert');

    const publicProfile = await api(`/api/public/experts/${create.data.slug}`);
    expect(publicProfile.status).toBe(200);
    expect(publicProfile.data.expert.display_name).toBe('Liora Morel');

    const removal = await api(`/api/admin/experts/${create.data.expertId}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(removal.status).toBe(200);
    expect((await api(`/api/public/experts/${create.data.slug}`)).status).toBe(404);
    expect(db.prepare('SELECT id FROM expert_profiles WHERE id = ?').get(create.data.expertId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM users WHERE email = ?').get(create.data.email)).toBeUndefined();

    const loginAfterRemoval = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: create.data.email,
        password: create.data.temporaryPassword,
      }),
    });
    expect(loginAfterRemoval.status).toBe(401);
  });

  it('permanently deletes experts and their linked history even while consultations are active', async () => {
    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = adminLogin.setCookie!.split(';')[0];
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const client = db.prepare("SELECT id FROM users WHERE email = 'claire@maison-astralis.demo'").get() as { id: string };
    const create = await api('/api/admin/experts', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ displayName: 'Liora Delete Test', specialty: 'Tarot', status: 'approved' }),
    });
    expect(create.status).toBe(201);
    const expertId = create.data.expertId as string;
    const expert = db.prepare('SELECT user_id FROM expert_profiles WHERE id = ?').get(expertId) as { user_id: string };
    const service = db.prepare('SELECT id FROM expert_services WHERE expert_id = ?').get(expertId) as { id: string };
    const consultationId = uuid();
    const conversationId = uuid();
    const appointmentId = uuid();
    const paymentId = uuid();
    const supportTicketId = uuid();
    const timestamp = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO consultations (
          id, client_id, expert_id, service_id, service_type, billing_model, unit_price_cents, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'chat_per_minute', 'per_minute', 250, 'active', ?, ?)
      `).run(consultationId, client.id, expertId, service.id, timestamp, timestamp);
      db.prepare(`
        INSERT INTO chat_conversations (id, consultation_id, client_id, expert_id, status, created_at)
        VALUES (?, ?, ?, ?, 'open', ?)
      `).run(conversationId, consultationId, client.id, expertId, timestamp);
      db.prepare(`
        INSERT INTO chat_messages (id, conversation_id, sender_id, content, created_at)
        VALUES (?, ?, ?, 'Message de test', ?)
      `).run(uuid(), conversationId, client.id, timestamp);
      db.prepare(`
        INSERT INTO appointments (
          id, client_id, expert_id, service_id, scheduled_start, scheduled_end, client_timezone, price_cents, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'Europe/Paris', 250, ?, ?)
      `).run(appointmentId, client.id, expertId, service.id, timestamp, timestamp, timestamp, timestamp);
      db.prepare(`
        INSERT INTO reviews (id, consultation_id, client_id, expert_id, rating, comment, created_at, updated_at)
        VALUES (?, ?, ?, ?, 5, 'Avis de test', ?, ?)
      `).run(uuid(), consultationId, client.id, expertId, timestamp, timestamp);
      db.prepare(`
        INSERT INTO expert_earnings (id, expert_id, consultation_id, gross_cents, commission_cents, net_cents, created_at)
        VALUES (?, ?, ?, 250, 50, 200, ?)
      `).run(uuid(), expertId, consultationId, timestamp);
      db.prepare(`
        INSERT INTO withdrawals (id, expert_id, amount_cents, payout_method, created_at, updated_at)
        VALUES (?, ?, 200, 'bank_transfer', ?, ?)
      `).run(uuid(), expertId, timestamp, timestamp);
      db.prepare(`
        INSERT INTO payments (id, user_id, provider, idempotency_key, amount_cents, status, created_at, updated_at)
        VALUES (?, ?, 'test', ?, 250, 'verified', ?, ?)
      `).run(paymentId, expert.user_id, `expert-delete-${uuid()}`, timestamp, timestamp);
      db.prepare(`
        INSERT INTO refunds (id, payment_id, consultation_id, user_id, amount_cents, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, 250, 'Test', ?, ?)
      `).run(uuid(), paymentId, consultationId, expert.user_id, timestamp, timestamp);
      db.prepare(`
        INSERT INTO wallet_transactions (
          id, user_id, type, amount_cents, balance_after_cents, reference_type, reference_id, description, created_at
        ) VALUES (?, ?, 'credit', 250, 250, 'consultation', ?, 'Test', ?)
      `).run(uuid(), expert.user_id, consultationId, timestamp);
      db.prepare(`
        INSERT INTO support_tickets (id, user_id, category, subject, created_at, updated_at)
        VALUES (?, ?, 'account', 'Ticket de test', ?, ?)
      `).run(supportTicketId, expert.user_id, timestamp, timestamp);
      db.prepare(`
        INSERT INTO support_messages (id, ticket_id, sender_id, is_staff, content, created_at)
        VALUES (?, ?, ?, 1, 'Réponse de test', ?)
      `).run(uuid(), supportTicketId, expert.user_id, timestamp);
      db.prepare(`
        INSERT INTO contact_messages (id, name, email, subject, message, created_at, updated_at, user_id)
        VALUES (?, 'Liora', ?, 'Contact test', 'Message de test', ?, ?, ?)
      `).run(uuid(), create.data.email, timestamp, timestamp, expert.user_id);
      db.prepare(`
        INSERT INTO commission_rules (id, scope, target_id, rate_bp, description, created_at)
        VALUES (?, 'expert', ?, 2500, 'Règle test', ?)
      `).run(uuid(), expertId, timestamp);
    })();

    const removal = await api(`/api/admin/experts/${expertId}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(removal.status).toBe(200);
    expect(removal.data).toMatchObject({ ok: true });
    expect(db.prepare('SELECT id FROM expert_profiles WHERE id = ?').get(expertId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(expert.user_id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM expert_services WHERE id = ?').get(service.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM consultations WHERE id = ?').get(consultationId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM chat_conversations WHERE id = ?').get(conversationId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM chat_messages WHERE conversation_id = ?').get(conversationId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM appointments WHERE id = ?').get(appointmentId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM reviews WHERE consultation_id = ?').get(consultationId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM expert_earnings WHERE consultation_id = ?').get(consultationId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM withdrawals WHERE expert_id = ?').get(expertId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM payments WHERE id = ?').get(paymentId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM refunds WHERE payment_id = ?').get(paymentId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM wallet_transactions WHERE user_id = ?').get(expert.user_id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM support_tickets WHERE id = ?').get(supportTicketId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM support_messages WHERE ticket_id = ?').get(supportTicketId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM contact_messages WHERE email = ?').get(create.data.email)).toBeUndefined();
    expect(db.prepare('SELECT id FROM commission_rules WHERE target_id = ?').get(expertId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(client.id)).toBeDefined();
    expect(db.prepare(`
      SELECT id FROM audit_logs
      WHERE actor_id = ? AND action = 'admin.expert_permanently_deleted' AND entity_id = ?
    `).get(adminId.id, expertId)).toBeDefined();
  });

  it('deletes an admin-owned expert profile without deleting the admin account', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@maison-astralis.local'").get() as { id: string };
    const hadExpertRole = Boolean(db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'expert'").get(admin.id));
    const expertId = uuid();
    const serviceId = uuid();
    const timestamp = new Date().toISOString();
    const cookie = `astralis_session=${signSessionToken(admin.id)}`;

    db.prepare(`
      INSERT INTO expert_profiles (
        id, user_id, slug, display_name, headline, specialty, category_slug, biography, created_at, updated_at
      ) VALUES (?, ?, ?, 'Admin Expert', 'Conseiller en tarot', 'Tarot', 'tarot', 'Profil de test', ?, ?)
    `).run(expertId, admin.id, `admin-expert-${expertId}`, timestamp, timestamp);
    db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(uuid(), admin.id, 'expert', timestamp);
    db.prepare(`
      INSERT INTO expert_services (
        id, expert_id, service_type, title, description, price_cents, currency, created_at, updated_at
      ) VALUES (?, ?, 'chat_per_minute', 'Service de test', 'Service lié au profil', 250, 'EUR', ?, ?)
    `).run(serviceId, expertId, timestamp, timestamp);

    try {
      const removal = await api(`/api/admin/experts/${expertId}`, { method: 'DELETE', cookie });
      expect(removal.status).toBe(200);
      expect(db.prepare('SELECT id, status FROM users WHERE id = ?').get(admin.id)).toMatchObject({ id: admin.id, status: 'active' });
      expect(db.prepare("SELECT role FROM user_roles WHERE user_id = ? AND role = 'admin'").get(admin.id)).toEqual({ role: 'admin' });
      expect(db.prepare("SELECT role FROM user_roles WHERE user_id = ? AND role = 'expert'").get(admin.id)).toBeUndefined();
      expect(db.prepare('SELECT id FROM expert_profiles WHERE id = ?').get(expertId)).toBeUndefined();
      expect(db.prepare('SELECT id FROM expert_services WHERE id = ?').get(serviceId)).toBeUndefined();
      expect(db.prepare(`
        SELECT id FROM audit_logs
        WHERE actor_id = ? AND action = 'admin.expert_permanently_deleted' AND entity_id = ?
      `).get(admin.id, expertId)).toBeDefined();
    } finally {
      db.prepare('DELETE FROM audit_logs WHERE entity_id = ?').run(expertId);
      db.prepare('DELETE FROM expert_profiles WHERE id = ?').run(expertId);
      if (hadExpertRole) {
        db.prepare('INSERT OR IGNORE INTO user_roles (id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
          .run(uuid(), admin.id, 'expert', timestamp);
      } else {
        db.prepare("DELETE FROM user_roles WHERE user_id = ? AND role = 'expert'").run(admin.id);
      }
    }
  });

  it('lets admins delete audit entries without creating new audit records', async () => {
    const now = new Date().toISOString();
    const entryId = `audit-test-${Date.now()}`;
    db.prepare(`
      INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, created_at)
      VALUES (?, NULL, 'test.audit_entry', 'test', ?, ?)
    `).run(entryId, entryId, now);

    const unauthenticated = await api(`/api/admin/audit-logs/${entryId}`, { method: 'DELETE' });
    expect(unauthenticated.status).toBe(401);

    const clientLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'claire@maison-astralis.demo', password: 'AstralisClient2026!' }),
    });
    const clientDelete = await api('/api/admin/audit-logs', {
      method: 'DELETE',
      cookie: clientLogin.setCookie!.split(';')[0],
    });
    expect(clientDelete.status).toBe(403);

    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = adminLogin.setCookie!.split(';')[0];

    const singleDelete = await api(`/api/admin/audit-logs/${entryId}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(singleDelete.status).toBe(200);
    expect(db.prepare('SELECT id FROM audit_logs WHERE id = ?').get(entryId)).toBeUndefined();
    expect(db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'admin.audit_log%'").all()).toEqual([]);

    const remainingLogs = (db.prepare('SELECT COUNT(*) as count FROM audit_logs').get() as { count: number }).count;
    const clearAll = await api('/api/admin/audit-logs', {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(clearAll.status).toBe(200);
    expect(clearAll.data.deletedCount).toBe(remainingLogs);
    expect(db.prepare('SELECT id FROM audit_logs').all()).toEqual([]);
  });

  it('blocks unauthenticated access to protected client, expert, and admin endpoints', async () => {
    const c = await api('/api/client/dashboard');
    const e = await api('/api/expert/dashboard');
    const a = await api('/api/admin/overview');
    expect(c.status).toBe(401);
    expect(e.status).toBe(401);
    expect(a.status).toBe(401);
  });

  it('prevents role escalation from client to expert or admin', async () => {
    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'claire@maison-astralis.demo', password: 'AstralisClient2026!' }),
    });
    expect(loginRes.status).toBe(200);
    const clientCookie = loginRes.setCookie!.split(';')[0];

    const expAttempt = await api('/api/expert/dashboard', { cookie: clientCookie });
    const admAttempt = await api('/api/admin/overview', { cookie: clientCookie });
    expect(expAttempt.status).toBe(403);
    expect(admAttempt.status).toBe(403);
  });

  it('blocks cross-user access to private consultation conversations', async () => {
    const loginClaire = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'claire@maison-astralis.demo', password: 'AstralisClient2026!' }),
    });
    const claireCookie = loginClaire.setCookie!.split(';')[0];
    const convs = await api('/api/client/conversations', { cookie: claireCookie });
    const claireConvId = convs.data.conversations[0].id;

    const loginJulien = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'julien@maison-astralis.demo', password: 'AstralisClient2026!' }),
    });
    const julienCookie = loginJulien.setCookie!.split(';')[0];
    const hijack = await api(`/api/client/conversations/${claireConvId}/messages`, { cookie: julienCookie });
    expect(hijack.status).toBe(404);
  });
});

describe('Integration Tests: End-to-End Marketplace Flows', () => {
  it('prevents duplicate sandbox payments using idempotency keys', async () => {
    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'julien@maison-astralis.demo', password: 'AstralisClient2026!' }),
    });
    const cookie = loginRes.setCookie!.split(';')[0];
    const before = await api('/api/client/wallet', { cookie });
    const initialCents = before.data.wallet.available_cents;

    const idemKey = `test-idem-${Date.now()}`;
    const first = await api('/api/client/payments/checkout', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ amountCents: 2000, provider: 'sandbox_demo', countryCode: 'FR', idempotencyKey: idemKey }),
    });
    const second = await api('/api/client/payments/checkout', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ amountCents: 2000, provider: 'sandbox_demo', countryCode: 'FR', idempotencyKey: idemKey }),
    });

    expect(first.status).toBe(201);
    expect(second.data.deduplicated).toBe(true);

    const after = await api('/api/client/wallet', { cookie });
    expect(after.data.wallet.available_cents).toBe(initialCents + 2000);
  });

  it('refuses live Stripe checkout when provider keys are not configured', async () => {
    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'julien@maison-astralis.demo', password: 'AstralisClient2026!' }),
    });
    const cookie = loginRes.setCookie!.split(';')[0];

    const liveAttempt = await api('/api/client/payments/checkout', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ amountCents: 2000, provider: 'stripe', countryCode: 'FR', idempotencyKey: `live-${Date.now()}` }),
    });
    expect(liveAttempt.status).toBe(503);
  });

  it('prevents double booking on the same appointment slot', async () => {
    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'claire@maison-astralis.demo', password: 'AstralisClient2026!' }),
    });
    const cookie = loginRes.setCookie!.split(';')[0];

    const expRes = await api('/api/public/experts/celeste-moreau');
    const expert = expRes.data.expert;
    const apptSvc = expert.services.find((s: { service_type: string }) => s.service_type === 'scheduled_appointment');

    const d = new Date(Date.now() + 8 * 86400000);
    while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
    const slotsRes = await api(`/api/public/experts/celeste-moreau/slots?date=${d.toISOString().slice(0, 10)}`);
    const openSlot = slotsRes.data.slots.find((s: { available: boolean }) => s.available);

    const book1 = await api('/api/client/appointments', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        expertId: expert.id,
        serviceId: apptSvc.id,
        scheduledStart: openSlot.startIso,
        clientTimezone: 'Europe/Paris',
      }),
    });
    expect(book1.status).toBe(201);

    const book2 = await api('/api/client/appointments', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        expertId: expert.id,
        serviceId: apptSvc.id,
        scheduledStart: openSlot.startIso,
        clientTimezone: 'Europe/Paris',
      }),
    });
    expect(book2.status).toBe(409);
  });

  it('supports independent client registration, blocks duplicate emails, and allows re-login', async () => {
    const uniqueEmail = `nouveau.membre.${Date.now()}@exemple.fr`;
    const withoutTerms = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'MotDePasseSur2026!',
        firstName: 'Camille',
        lastName: 'Laurent',
        phone: '+33612345678',
      }),
    });
    expect(withoutTerms.status).toBe(400);

    const reg1 = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'MotDePasseSur2026!',
        firstName: 'Camille',
        lastName: 'Laurent',
        phone: '+33612345678',
        termsAccepted: true,
      }),
    });
    expect(reg1.status).toBe(201);
    expect(reg1.data.user.email).toBe(uniqueEmail);
    expect(db.prepare('SELECT phone FROM client_profiles WHERE user_id = ?').get(reg1.data.user.id)).toEqual({ phone: '+33612345678' });
    expect(db.prepare('SELECT terms_accepted_at FROM client_profiles WHERE user_id = ?').get(reg1.data.user.id))
      .toMatchObject({ terms_accepted_at: expect.any(String) });

    // Duplicate email rejected with 409
    const regDup = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'AutreMotDePasse2026!',
        firstName: 'Autre',
        lastName: 'Compte',
        phone: '+33698765432',
        termsAccepted: true,
      }),
    });
    expect(regDup.status).toBe(409);

    // Re-login with newly created account credentials
    const loginNew = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail,
        password: 'MotDePasseSur2026!',
      }),
    });
    expect(loginNew.status).toBe(200);
    const newCookie = loginNew.setCookie!.split(';')[0];

    const meRes = await api('/api/auth/me', { cookie: newCookie });
    expect(meRes.status).toBe(200);
    expect(meRes.data.user.profile.first_name).toBe('Camille');
    expect(meRes.data.user.profile.phone).toBe('+33612345678');
    expect(meRes.data.user.wallet.available_cents).toBe(0);

    // New user with 0 EUR wallet can start a free 0,00 EUR consultation while preserving service price_cents
    const expRes = await api('/api/public/experts/nadia-mansour');
    const perMsgSvc = expRes.data.expert.services.find((s: { service_type: string }) => s.service_type === 'chat_per_message');
    expect(perMsgSvc.price_cents).toBeGreaterThan(0);

    const freeStart = await api('/api/client/consultations/start', {
      method: 'POST',
      cookie: newCookie,
      body: JSON.stringify({ expertId: expRes.data.expert.id, serviceId: perMsgSvc.id }),
    });
    expect(freeStart.status).toBe(201);
    expect(freeStart.data.appliedFreeOffer).toBe(true);
  });

  it('exposes and centrally updates Main Number and Free Offer settings', async () => {
    const boot1 = await api('/api/public/bootstrap');
    expect(boot1.status).toBe(200);
    expect(boot1.data.settings.main_number).toBe('+33123456789');
    expect(boot1.data.settings.free_offer_enabled).toBe(true);

    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = adminLogin.setCookie!.split(';')[0];

    const upd = await api('/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ key: 'main_number', value: '+33199887766' }),
    });
    expect(upd.status).toBe(200);

    const boot2 = await api('/api/public/bootstrap');
    expect(boot2.data.settings.main_number).toBe('+33199887766');

    // Restore default Main Number
    await api('/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ key: 'main_number', value: '+33123456789' }),
    });
  });

  it('enforces server-side paid chat billing, settlement, and review eligibility when standard billing is active', async () => {
    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = adminLogin.setCookie!.split(';')[0];

    await api('/api/admin/settings', {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ key: 'free_offer_enabled', value: false }),
    });

    try {
      const loginRes = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'claire@maison-astralis.demo', password: 'AstralisClient2026!' }),
      });
      const cookie = loginRes.setCookie!.split(';')[0];

      const expRes = await api('/api/public/experts/nadia-mansour');
      const expert = expRes.data.expert;
      const perMsgSvc = expert.services.find((s: { service_type: string }) => s.service_type === 'chat_per_message');

      const startRes = await api('/api/client/consultations/start', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ expertId: expert.id, serviceId: perMsgSvc.id }),
      });
      expect(startRes.status).toBe(201);
      const { consultationId, conversationId } = startRes.data;

      // Cannot review before completion
      const earlyRev = await api('/api/client/reviews', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ consultationId, rating: 5, comment: 'Trying to review early should fail.' }),
      });
      expect(earlyRev.status).toBe(403);

      // Send 1 paid message
      const msgRes = await api(`/api/client/conversations/${conversationId}/messages`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({ content: 'Bonjour Nadia, je souhaite un éclairage sur ma période actuelle.' }),
      });
      expect(msgRes.status).toBe(201);
      expect(msgRes.data.message.billed_cents).toBe(perMsgSvc.price_cents);

      // End & Settle consultation
      const endRes = await api(`/api/client/consultations/${consultationId}/end`, { method: 'POST', cookie });
      expect(endRes.status).toBe(200);
      expect(endRes.data.consultation.status).toBe('completed');
      expect(endRes.data.consultation.gross_amount_cents).toBe(perMsgSvc.price_cents);

      // Now review succeeds
      const validRev = await api('/api/client/reviews', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ consultationId, rating: 5, comment: 'Une guidance attentive et structurée tout au long de la séance.' }),
      });
      expect(validRev.status).toBe(201);
    } finally {
      await api('/api/admin/settings', {
        method: 'PATCH',
        cookie: adminCookie,
        body: JSON.stringify({ key: 'free_offer_enabled', value: true }),
      });
    }
  });

  it('supports expert application submission and admin approval conversion', async () => {
    const uniqueEmail = `applicant-${Date.now()}@example.org`;
    const applyRes = await api('/api/public/expert-applications', {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Lucie Bernard',
        displayName: 'Lucie Bernard',
        email: uniqueEmail,
        phone: '+33655443322',
        country: 'France',
        languages: ['fr'],
        specialties: ['Tarot'],
        yearsExperience: 7,
        biography: 'Sept années de consultation en tarot classique et étude symbolique à Bordeaux.',
        methods: ['chat', 'scheduled_appointment'],
        portfolioUrl: 'https://example.org/lucie-portfolio',
      }),
    });
    expect(applyRes.status).toBe(201);

    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = adminLogin.setCookie!.split(';')[0];

    const applicationList = await api('/api/admin/applications', { cookie: adminCookie });
    expect(applicationList.status).toBe(200);
    const application = applicationList.data.applications.find(
      (item: { id: string }) => item.id === applyRes.data.applicationId
    );
    expect(application).toMatchObject({
      full_name: 'Lucie Bernard',
      display_name: 'Lucie Bernard',
      email: uniqueEmail,
      phone: '+33655443322',
      country: 'France',
      languages_json: '["fr"]',
      specialties_json: '["Tarot"]',
      years_experience: 7,
      biography: 'Sept années de consultation en tarot classique et étude symbolique à Bordeaux.',
      methods_json: '["chat","scheduled_appointment"]',
      portfolio_url: 'https://example.org/lucie-portfolio',
    });

    const approveRes = await api(`/api/admin/applications/${applyRes.data.applicationId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'approved', internalNotes: 'Dossier vérifié.' }),
    });
    expect(approveRes.status).toBe(200);
    expect(db.prepare('SELECT id FROM expert_applications WHERE id = ?').get(applyRes.data.applicationId)).toBeUndefined();

    const applicantUser = db.prepare('SELECT id, status FROM users WHERE email = ?').get(uniqueEmail) as
      | { id: string; status: string }
      | undefined;
    expect(applicantUser?.status).toBe('suspended');
    const expertProfile = db.prepare('SELECT id, slug, status, presence_status FROM expert_profiles WHERE user_id = ?')
      .get(applicantUser!.id) as { id: string; slug: string; status: string; presence_status: string };
    expect(expertProfile).toMatchObject({ status: 'suspended', presence_status: 'offline' });

    const expertsList = await api('/api/public/experts');
    expect(expertsList.data.items.some((e: { display_name: string }) => e.display_name === 'Lucie Bernard')).toBe(false);

    const profileEdit = await api(`/api/admin/experts/${expertProfile.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({
        displayName: 'Lucie Bernard',
        headline: 'Tarologue indépendante',
        specialty: 'Tarot',
        biography: 'Profil relu et validé par l’administration.',
        yearsExperience: 7,
        languages: ['Français', 'Anglais'],
      }),
    });
    expect(profileEdit.status).toBe(200);
    expect(db.prepare('SELECT status, display_name, biography FROM expert_profiles WHERE id = ?').get(expertProfile.id))
      .toEqual({ status: 'suspended', display_name: 'Lucie Bernard', biography: 'Profil relu et validé par l’administration.' });

    const activate = await api(`/api/admin/experts/${expertProfile.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(activate.status).toBe(200);
    expect(db.prepare('SELECT status FROM users WHERE id = ?').get(applicantUser!.id)).toEqual({ status: 'active' });
    expect(db.prepare('SELECT status FROM expert_profiles WHERE id = ?').get(expertProfile.id)).toEqual({ status: 'approved' });
    expect((await api('/api/public/experts')).data.items.some((e: { display_name: string }) => e.display_name === 'Lucie Bernard')).toBe(true);
  });

  it('permanently deletes refused expert applications and records the admin action', async () => {
    const application = await api('/api/public/expert-applications', {
      method: 'POST',
      body: JSON.stringify({
        fullName: 'Nina Morel',
        displayName: 'Nina Morel',
        email: `nina-${Date.now()}@example.org`,
        phone: '+33612345678',
        country: 'France',
        languages: ['fr'],
        specialties: ['Astrologie'],
        yearsExperience: 5,
        biography: 'Cinq années de pratique de l’astrologie et de l’accompagnement individuel.',
        methods: ['chat'],
      }),
    });
    expect(application.status).toBe(201);
    const applicationId = application.data.applicationId as string;
    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@maison-astralis.local', password: '1122' }),
    });
    const adminCookie = adminLogin.setCookie!.split(';')[0];

    const deletion = await api(`/api/admin/applications/${applicationId}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(deletion.status).toBe(200);
    expect(db.prepare('SELECT id FROM expert_applications WHERE id = ?').get(applicationId)).toBeUndefined();
    expect(db.prepare("SELECT action FROM audit_logs WHERE entity_type = 'expert_application' AND entity_id = ? ORDER BY created_at DESC LIMIT 1").get(applicationId))
      .toEqual({ action: 'admin.application_rejected_and_deleted' });
  });
});
