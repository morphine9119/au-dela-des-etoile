import { DurableObject } from 'cloudflare:workers';
import { createApp } from '../server/app.ts';
import { bindDatabase, initDatabase } from '../server/db.ts';
import { createDurableObjectDriver } from '../server/sql-driver.ts';
import {
  authenticateSocketRequest,
  bindSocketHub,
  connectedMessage,
  handleSocketMessage,
  initialSocketState,
  unauthorizedMessage,
  type HubSocket,
} from '../server/ws.ts';

export interface Env {
  BACKEND: DurableObjectNamespace<AstralisBackend>;
  ASSETS: Fetcher;
  APP_ENV?: string;
  JWT_SECRET?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  [key: string]: unknown;
}

/**
 * The whole backend (SQLite database, REST API and WebSocket chat) lives in a single
 * SQLite-backed Durable Object. Because Durable Object SQLite is synchronous and
 * strongly consistent, the original synchronous business logic (wallet debits,
 * double-booking prevention, per-message billing) keeps its exact semantics.
 */
export class AstralisBackend extends DurableObject<Env> {
  private app: ReturnType<typeof createApp>;
  private initError: unknown = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Expose plain-string vars and secrets as process.env for the shared server code.
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') process.env[key] = value;
    }

    bindDatabase(createDurableObjectDriver(ctx.storage as never));
    bindSocketHub({
      all: () => ctx.getWebSockets() as unknown as HubSocket[],
      byUser: (userId) => ctx.getWebSockets(`user:${userId}`) as unknown as HubSocket[],
    });
    this.app = createApp();

    ctx.blockConcurrencyWhile(async () => {
      try {
        initDatabase();
      } catch (error) {
        this.initError = error;
        console.error('Database initialisation failed:', error);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (this.initError) {
      const message = this.initError instanceof Error ? this.initError.message : 'Initialisation failed';
      return Response.json({ error: 'Configuration serveur invalide', detail: message }, { status: 500 });
    }

    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const auth = authenticateSocketRequest(request);
      if (!auth) {
        server.accept();
        server.send(unauthorizedMessage());
        server.close(4001, 'Non autorisé');
        return new Response(null, { status: 101, webSocket: client });
      }
      this.ctx.acceptWebSocket(server, [`user:${auth.userId}`]);
      server.serializeAttachment(initialSocketState(auth.userId));
      server.send(connectedMessage(auth.userId, auth.roles));
      return new Response(null, { status: 101, webSocket: client });
    }

    return this.app.fetch(request);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    handleSocketMessage(ws as unknown as HubSocket, message);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'error');
    } catch {
      // already closed
    }
  }
}
