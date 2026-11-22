import { COOKIE_NAME, loadAuthUser, verifySessionToken } from './auth.ts';
import { db, nowIso, uuid } from './db.ts';
import { parseCookieHeader } from './http/express-lite.ts';
import { debitWalletAtomic } from './services/finance.ts';

/**
 * Real-time layer built on Durable Object WebSocket Hibernation.
 *
 * Per-socket state (user id + joined rooms) lives in the WebSocket attachment,
 * so it survives the Durable Object being evicted from memory between messages.
 * The hub is bound by the Durable Object; in Node tests no hub is bound and
 * broadcasts are simply no-ops.
 */
export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface SocketHub {
  all(): HubSocket[];
  byUser(userId: string): HubSocket[];
}

interface SocketState {
  userId: string;
  rooms: string[];
}

let hub: SocketHub | null = null;

export function bindSocketHub(next: SocketHub | null): void {
  hub = next;
}

function stateOf(ws: HubSocket): SocketState | null {
  try {
    return (ws.deserializeAttachment() as SocketState | null) ?? null;
  } catch {
    return null;
  }
}

function safeSend(ws: HubSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    // socket already closed
  }
}

export function broadcastToRoom(roomId: string, event: string, payload: unknown): void {
  if (!hub) return;
  const serialized = JSON.stringify({ event, payload });
  for (const ws of hub.all()) {
    if (stateOf(ws)?.rooms.includes(roomId)) safeSend(ws, serialized);
  }
}

export function pushNotificationToUser(userId: string, notification: unknown): void {
  if (!hub) return;
  const serialized = JSON.stringify({ event: 'notification:new', payload: notification });
  for (const ws of hub.byUser(userId)) safeSend(ws, serialized);
}

export function broadcastPresence(expertProfileId: string, status: 'online' | 'busy' | 'offline'): void {
  if (!hub) return;
  const serialized = JSON.stringify({
    event: 'presence:updated',
    payload: { expertId: expertProfileId, presenceStatus: status },
  });
  for (const ws of hub.all()) safeSend(ws, serialized);
}

/**
 * Authenticate a WebSocket upgrade request. Returns the user id, or null when the
 * request carries no valid session (cookie or ?token=).
 */
export function authenticateSocketRequest(request: Request): { userId: string; roles: string[] } | null {
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const url = new URL(request.url);
  const token = cookies[COOKIE_NAME] || url.searchParams.get('token') || undefined;
  const verified = token ? verifySessionToken(token) : null;
  const user = verified ? loadAuthUser(verified.sub) : null;
  return user ? { userId: user.id, roles: user.roles } : null;
}

export function initialSocketState(userId: string): SocketState {
  return { userId, rooms: [] };
}

export function connectedMessage(userId: string, roles: string[]): string {
  return JSON.stringify({ event: 'connected', payload: { userId, roles } });
}

export function unauthorizedMessage(): string {
  return JSON.stringify({ event: 'error', payload: { message: 'Authentification requise' } });
}

/** Handle one inbound WebSocket frame. */
export function handleSocketMessage(ws: HubSocket, data: string | ArrayBuffer): void {
  const reply = (event: string, payload: unknown) => safeSend(ws, JSON.stringify({ event, payload }));
  try {
    const state = stateOf(ws);
    if (!state) return;
    // Re-check on every frame so suspended/deleted users lose access immediately.
    const user = loadAuthUser(state.userId);
    if (!user) {
      reply('error', { message: 'Authentification requise' });
      ws.close(4001, 'Non autorisé');
      return;
    }

    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const parsed = JSON.parse(text) as { action?: string; conversationId?: string; content?: string };

    if (parsed.action === 'join_conversation' && parsed.conversationId) {
      const conv = db
        .prepare(`
          SELECT c.id, c.client_id, ep.user_id as expert_user_id
          FROM chat_conversations c
          JOIN expert_profiles ep ON ep.id = c.expert_id
          WHERE c.id = ?
        `)
        .get(parsed.conversationId) as { id: string; client_id: string; expert_user_id: string } | undefined;

      if (!conv) {
        reply('error', { message: 'Conversation introuvable' });
        return;
      }
      if (conv.client_id !== user.id && conv.expert_user_id !== user.id) {
        reply('error', { message: 'Accès interdit à cette conversation' });
        return;
      }

      if (!state.rooms.includes(conv.id)) {
        state.rooms.push(conv.id);
        ws.serializeAttachment(state);
      }
      reply('conversation:joined', { conversationId: conv.id });
      return;
    }

    if (parsed.action === 'leave_conversation' && parsed.conversationId) {
      state.rooms = state.rooms.filter((r) => r !== parsed.conversationId);
      ws.serializeAttachment(state);
      return;
    }

    if (parsed.action === 'send_message' && parsed.conversationId && typeof parsed.content === 'string') {
      const clean = parsed.content.trim();
      if (!clean || clean.length > 4000) {
        reply('error', { message: 'Le message doit contenir entre 1 et 4000 caractères' });
        return;
      }

      const result = handleAuthorizedChatMessage({
        conversationId: parsed.conversationId,
        senderId: user.id,
        content: clean,
      });

      if ('error' in result) {
        reply('error', { message: result.error });
        return;
      }

      broadcastToRoom(parsed.conversationId, 'message:created', result.message);
    }
  } catch {
    reply('error', { message: 'Charge utile WebSocket invalide' });
  }
}

export function handleAuthorizedChatMessage(params: {
  conversationId: string;
  senderId: string;
  content: string;
}): { message: Record<string, unknown> } | { error: string } {
  const conv = db
    .prepare(`
      SELECT c.*, ep.user_id as expert_user_id, ep.display_name as expert_name
      FROM chat_conversations c
      JOIN expert_profiles ep ON ep.id = c.expert_id
      WHERE c.id = ?
    `)
    .get(params.conversationId) as
    | {
        id: string;
        consultation_id: string | null;
        client_id: string;
        expert_id: string;
        expert_user_id: string;
        expert_name: string;
        status: string;
      }
    | undefined;

  if (!conv) return { error: 'Conversation introuvable' };
  if (conv.client_id !== params.senderId && conv.expert_user_id !== params.senderId) {
    return { error: 'Participant non autorisé' };
  }
  if (conv.status !== 'open') {
    return { error: 'Cette conversation est clôturée' };
  }

  const ts = nowIso();
  const msgId = uuid();
  let billedCents = 0;

  // Server-side metering for active paid per-message consultation when client sends
  if (conv.consultation_id && params.senderId === conv.client_id) {
    const consult = db.prepare('SELECT * FROM consultations WHERE id = ?').get(conv.consultation_id) as
      | { id: string; status: string; billing_model: string; unit_price_cents: number }
      | undefined;

    if (consult && consult.status === 'active' && consult.billing_model === 'per_message' && consult.unit_price_cents > 0) {
      try {
        debitWalletAtomic({
          userId: conv.client_id,
          amountCents: consult.unit_price_cents,
          referenceType: 'chat_message',
          referenceId: msgId,
          description: `Message avec ${conv.expert_name}`,
          idempotencyKey: `msg-debit-${msgId}`,
        });
        billedCents = consult.unit_price_cents;
        db.prepare(`
          UPDATE consultations
          SET units_consumed = units_consumed + 1,
              gross_amount_cents = gross_amount_cents + ?,
              updated_at = ?
          WHERE id = ?
        `).run(billedCents, ts, consult.id);
      } catch (err) {
        if (err instanceof Error && err.message === 'INSUFFICIENT_WALLET_BALANCE') {
          return { error: 'Solde insuffisant pour envoyer un message payant. Veuillez recharger votre portefeuille.' };
        }
        return { error: 'Échec de la vérification de facturation' };
      }
    }
  }

  db.prepare('INSERT INTO chat_messages (id, conversation_id, sender_id, content, is_read, billed_cents, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .run(msgId, conv.id, params.senderId, params.content, billedCents, ts);
  db.prepare('UPDATE chat_conversations SET last_message_at = ? WHERE id = ?').run(ts, conv.id);

  // Create notification for recipient
  const recipientId = params.senderId === conv.client_id ? conv.expert_user_id : conv.client_id;
  const notifId = uuid();
  const linkUrl = params.senderId === conv.client_id ? '/expert/messages' : '/account/messages';
  db.prepare('INSERT INTO notifications (id, user_id, type, title, body, link_url, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(notifId, recipientId, 'new_message', 'Nouveau message de consultation', params.content.slice(0, 120), linkUrl, ts);

  pushNotificationToUser(recipientId, {
    id: notifId,
    type: 'new_message',
    title: 'Nouveau message de consultation',
    body: params.content.slice(0, 120),
    link_url: linkUrl,
    created_at: ts,
  });

  const message = db
    .prepare(`
      SELECT m.*, cp.first_name, cp.last_name
      FROM chat_messages m
      LEFT JOIN client_profiles cp ON cp.user_id = m.sender_id
      WHERE m.id = ?
    `)
    .get(msgId) as Record<string, unknown>;

  return { message };
}
