/**
 * express-lite — a tiny Express-compatible router built on the Web standard
 * Request/Response objects, so the existing route modules run unchanged on
 * Cloudflare Workers (and in Node for tests).
 *
 * Supported surface (everything the app actually uses):
 *   Router(), app.use(mw | path, mw | router), get/post/put/patch/delete
 *   req: method, path, baseUrl, url, params, query, body, headers, cookies, ip, secure
 *   res: status(), json(), send(), type(), set(), cookie(), clearCookie(), end()
 *   Middleware may be sync or async; thrown errors become a JSON 500.
 */

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  maxAge?: number; // milliseconds, like Express
  path?: string;
}

export interface Request {
  method: string;
  url: string;
  path: string;
  baseUrl: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: any;
  headers: Record<string, string | undefined>;
  cookies: Record<string, string>;
  ip: string;
  secure: boolean;
  authUser?: import('../auth.ts').AuthUser;
}

export interface Response {
  finished: boolean;
  status(code: number): Response;
  json(payload: unknown): Response;
  send(payload?: string | Uint8Array | ArrayBuffer | null): Response;
  type(mime: string): Response;
  set(name: string, value: string): Response;
  cookie(name: string, value: string, options?: CookieOptions): Response;
  clearCookie(name: string, options?: CookieOptions): Response;
  end(): Response;
}

export type NextFunction = (err?: unknown) => void;
export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

interface Matcher {
  regex: RegExp;
  keys: string[];
}

function compile(path: string, prefix: boolean): Matcher {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const tail = prefix ? '(?=/|$)' : '/?$';
  return { regex: new RegExp(`^${source === '' ? '' : source}${tail}`), keys };
}

function matchPath(matcher: Matcher, pathname: string): { params: Record<string, string>; matched: string } | null {
  const m = matcher.regex.exec(pathname);
  if (!m) return null;
  const params: Record<string, string> = {};
  matcher.keys.forEach((key, i) => {
    try {
      params[key] = decodeURIComponent(m[i + 1]);
    } catch {
      params[key] = m[i + 1];
    }
  });
  return { params, matched: m[0].replace(/\/$/, '') };
}

interface Layer {
  method?: string; // undefined = any (middleware)
  matcher?: Matcher; // undefined = match everything
  isRoute: boolean;
  handlers: Handler[];
  router?: RouterImpl;
}

export class RouterImpl {
  private stack: Layer[] = [];

  use(...args: Array<string | Handler | RouterImpl>): this {
    let matcher: Matcher | undefined;
    if (typeof args[0] === 'string') {
      const p = args.shift() as string;
      matcher = p === '/' ? undefined : compile(p.replace(/\/$/, ''), true);
    }
    for (const arg of args) {
      if (arg instanceof RouterImpl) {
        this.stack.push({ isRoute: false, matcher, handlers: [], router: arg });
      } else {
        this.stack.push({ isRoute: false, matcher, handlers: [arg as Handler] });
      }
    }
    return this;
  }

  private route(method: string, path: string, handlers: Handler[]): this {
    this.stack.push({ isRoute: true, method, matcher: compile(path.replace(/(.)\/$/, '$1'), false), handlers });
    return this;
  }

  get(path: string, ...handlers: Handler[]) { return this.route('GET', path, handlers); }
  post(path: string, ...handlers: Handler[]) { return this.route('POST', path, handlers); }
  put(path: string, ...handlers: Handler[]) { return this.route('PUT', path, handlers); }
  patch(path: string, ...handlers: Handler[]) { return this.route('PATCH', path, handlers); }
  delete(path: string, ...handlers: Handler[]) { return this.route('DELETE', path, handlers); }

  /** Run the stack. Calls `done` when no layer handled the request (or with an error). */
  handle(req: Request, res: Response, done: NextFunction): void {
    let index = 0;

    const next: NextFunction = (err?: unknown) => {
      if (err) return done(err);
      if (res.finished) return;

      const layer = this.stack[index++];
      if (!layer) return done();

      // Method filter for routes
      if (layer.isRoute && layer.method !== req.method && !(req.method === 'HEAD' && layer.method === 'GET')) {
        return next();
      }

      let params = req.params;
      let matchedPrefix = '';
      if (layer.matcher) {
        const m = matchPath(layer.matcher, req.path);
        if (!m) return next();
        params = layer.isRoute ? m.params : { ...req.params, ...m.params };
        matchedPrefix = layer.isRoute ? '' : m.matched;
      }

      const savedParams = req.params;
      const savedBase = req.baseUrl;
      const savedPath = req.path;
      req.params = params;

      const restore = () => {
        req.params = savedParams;
        req.baseUrl = savedBase;
        req.path = savedPath;
      };

      if (layer.router) {
        req.baseUrl = savedBase + matchedPrefix;
        req.path = savedPath.slice(matchedPrefix.length) || '/';
        layer.router.handle(req, res, (e) => {
          restore();
          next(e);
        });
        return;
      }

      if (matchedPrefix) {
        req.baseUrl = savedBase + matchedPrefix;
        req.path = savedPath.slice(matchedPrefix.length) || '/';
      }

      // Run this layer's handlers in order (route handler chains).
      let h = 0;
      const nextHandler: NextFunction = (e?: unknown) => {
        if (e) {
          restore();
          return next(e);
        }
        if (res.finished) return;
        const fn = layer.handlers[h++];
        if (!fn) {
          restore();
          return next();
        }
        try {
          const result = fn(req, res, nextHandler);
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            (result as Promise<unknown>).catch((error) => nextHandler(error));
          }
        } catch (error) {
          nextHandler(error);
        }
      };
      nextHandler();
    };

    next();
  }
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function serializeCookie(name: string, value: string, o: CookieOptions & { expires?: Date }): string {
  let out = `${name}=${encodeURIComponent(value)}`;
  if (o.maxAge !== undefined) out += `; Max-Age=${Math.floor(o.maxAge / 1000)}`;
  out += `; Path=${o.path || '/'}`;
  if (o.expires) out += `; Expires=${o.expires.toUTCString()}`;
  if (o.httpOnly) out += '; HttpOnly';
  if (o.secure) out += '; Secure';
  if (o.sameSite) out += `; SameSite=${o.sameSite[0].toUpperCase()}${o.sameSite.slice(1)}`;
  return out;
}

export interface AppOptions {
  /** Maximum JSON body size in bytes (default 8 MB, same as the original server). */
  jsonLimit?: number;
}

export class App extends RouterImpl {
  constructor(private options: AppOptions = {}) {
    super();
  }

  /** Handle a standard fetch Request and resolve with a standard Response. */
  async fetch(request: globalThis.Request): Promise<globalThis.Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const query: Record<string, string | string[]> = {};
    url.searchParams.forEach((value, key) => {
      const existing = query[key];
      if (existing === undefined) query[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else query[key] = [existing, value];
    });

    let body: any = {};
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const contentType = headers['content-type'] || '';
      const limit = this.options.jsonLimit ?? 8 * 1024 * 1024;
      if (contentType.includes('application/json')) {
        const text = await request.text();
        if (text.length > limit) {
          return jsonResponse(413, { error: 'Requête trop volumineuse' });
        }
        if (text.trim()) {
          try {
            body = JSON.parse(text);
          } catch {
            return jsonResponse(400, { error: 'JSON invalide' });
          }
        }
      }
    }

    const req: Request = {
      method: request.method.toUpperCase(),
      url: url.pathname + url.search,
      path: url.pathname,
      baseUrl: '',
      params: {},
      query,
      body,
      headers,
      cookies: parseCookieHeader(headers.cookie),
      ip: headers['cf-connecting-ip'] || headers['x-forwarded-for']?.split(',')[0]?.trim() || 'local',
      secure: url.protocol === 'https:',
    };

    return new Promise<globalThis.Response>((resolve) => {
      let status = 200;
      const resHeaders = new Headers();
      let finished = false;

      const finish = (payload: BodyInit | null) => {
        if (finished) return;
        finished = true;
        res.finished = true;
        const isHead = req.method === 'HEAD';
        resolve(new globalThis.Response(isHead ? null : payload, { status, headers: resHeaders }));
      };

      const res: Response = {
        finished: false,
        status(code) { status = code; return res; },
        type(mime) { resHeaders.set('Content-Type', mime === 'text' ? 'text/plain; charset=utf-8' : mime); return res; },
        set(name, value) { resHeaders.set(name, value); return res; },
        json(payload) {
          resHeaders.set('Content-Type', 'application/json; charset=utf-8');
          finish(JSON.stringify(payload));
          return res;
        },
        send(payload) {
          if (payload === undefined || payload === null) {
            finish(null);
          } else {
            if (typeof payload === 'string' && !resHeaders.has('Content-Type')) {
              resHeaders.set('Content-Type', 'text/html; charset=utf-8');
            }
            finish(payload as BodyInit);
          }
          return res;
        },
        cookie(name, value, options = {}) {
          resHeaders.append('Set-Cookie', serializeCookie(name, value, options));
          return res;
        },
        clearCookie(name, options = {}) {
          resHeaders.append('Set-Cookie', serializeCookie(name, '', { ...options, expires: new Date(0) }));
          return res;
        },
        end() { finish(null); return res; },
      };

      this.handle(req, res, (err) => {
        if (finished) return;
        if (err) {
          console.error('Unhandled route error:', err);
          status = 500;
          res.json({ error: 'Erreur interne du serveur' });
          return;
        }
        status = 404;
        res.json({ error: 'Route introuvable' });
      });
    });
  }
}

function jsonResponse(status: number, payload: unknown): globalThis.Response {
  return new globalThis.Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Express-style factory: `Router()` (no `new`). */
export function Router(): RouterImpl {
  return new RouterImpl();
}
