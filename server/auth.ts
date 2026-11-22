import { isProduction } from './env.ts';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from './http/express-lite.ts';
import { db, nowIso, uuid } from './db.ts';

// Read lazily: on Cloudflare the secrets are only available once the Durable
// Object has been constructed, not at module-import time.
let cachedSecret: string | null = null;
export function getJwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.JWT_SECRET?.trim();
  if (isProduction() && (!configured || configured.length < 32)) {
    throw new Error('JWT_SECRET must be set to a unique value of at least 32 characters in production.');
  }
  cachedSecret = configured || crypto.randomBytes(48).toString('hex');
  return cachedSecret;
}
export const COOKIE_NAME = 'astralis_session';

export type UserRole = 'client' | 'expert' | 'admin' | 'staff';

export interface AuthUser {
  id: string;
  email: string;
  status: string;
  is_demo: boolean;
  roles: UserRole[];
  expertProfileId?: string | null;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function b64url(input: string | Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', getJwtSecret()).update(data).digest('base64url');
}

/** HS256 JWT (compatible with the tokens the previous jsonwebtoken-based server issued). */
export function signSessionToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: userId, iat: now, exp: now + SESSION_TTL_SECONDS }));
  return `${header}.${payload}.${hmac(`${header}.${payload}`)}`;
}

export function verifySessionToken(token: string): { sub: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expected = hmac(`${header}.${payload}`);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string };
    if (head.alg !== 'HS256') return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; exp?: number };
    if (!decoded.sub) return null;
    if (typeof decoded.exp === 'number' && decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: decoded.sub };
  } catch {
    return null;
  }
}

function isHttpsRequest(req?: Request): boolean {
  if (!req) return isProduction();
  const proto = req.headers['x-forwarded-proto'];
  const forwardedHttps = proto?.split(',')[0]?.trim() === 'https';
  return Boolean(req.secure || forwardedHttps || isProduction());
}

export function setSessionCookie(res: Response, token: string, req?: Request): void {
  const https = isHttpsRequest(req);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: https,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response, req?: Request): void {
  const https = isHttpsRequest(req);
  res.clearCookie(COOKIE_NAME, {
    path: '/',
    sameSite: 'lax',
    secure: https,
  });
}

export function loadAuthUser(userId: string): AuthUser | null {
  const user = db.prepare('SELECT id, email, status, is_demo FROM users WHERE id = ? AND deleted_at IS NULL').get(userId) as
    | { id: string; email: string; status: string; is_demo: number }
    | undefined;
  if (!user || user.status !== 'active') return null;

  const roleRows = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId) as Array<{ role: UserRole }>;
  const roles = roleRows.map((r) => r.role);

  let expertProfileId: string | null = null;
  if (roles.includes('expert')) {
    const ep = db.prepare('SELECT id FROM expert_profiles WHERE user_id = ?').get(userId) as { id: string } | undefined;
    expertProfileId = ep?.id ?? null;
  }

  return {
    id: user.id,
    email: user.email,
    status: user.status,
    is_demo: Boolean(user.is_demo),
    roles,
    expertProfileId,
  };
}

export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME] || extractBearer(req.headers.authorization);
  if (token) {
    const verified = verifySessionToken(token);
    if (verified) {
      const user = loadAuthUser(verified.sub);
      if (user) {
        req.authUser = user;
      }
    }
  }
  next();
}

function extractBearer(header?: string): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentification requise' });
    return;
  }
  next();
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'Authentification requise' });
      return;
    }
    const hasRole = req.authUser.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) {
      res.status(403).json({ error: 'Permissions insuffisantes' });
      return;
    }
    next();
  };
}

// Simple sliding-window rate limiter per IP + route bucket
const rateBuckets = new Map<string, number[]>();

export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.ip || 'local'}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const recent = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= maxRequests) {
      res.status(429).json({ error: 'Trop de requêtes. Veuillez patienter un instant avant de réessayer.' });
      return;
    }
    recent.push(now);
    rateBuckets.set(key, recent);
    next();
  };
}

export function writeAuditLog(params: {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}): void {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, details_json, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    params.actorId ?? null,
    params.action,
    params.entityType,
    params.entityId,
    params.details ? JSON.stringify(params.details) : null,
    params.ipAddress ?? null,
    nowIso()
  );
}
