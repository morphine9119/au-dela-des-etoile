import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getAuthToken } from '../lib/api';
import { useAuth } from './AuthContext';

type WsHandler = (event: string, payload: unknown) => void;

interface WebSocketContextValue {
  connected: boolean;
  send: (payload: Record<string, unknown>) => void;
  subscribe: (handler: WsHandler) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<WsHandler>>(new Set());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!user) {
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
      return;
    }

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function connect() {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getAuthToken();
      const wsUrl = token
        ? `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
        : `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };

      ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as { event: string; payload: unknown };
          for (const h of handlersRef.current) {
            h(parsed.event, parsed.payload);
          }
        } catch {
          // ignore malformed packet
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          const delay = Math.min(10000, 1000 * Math.pow(2, attempt++));
          reconnectTimer = setTimeout(connect, delay);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [user?.id]);

  const send = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const subscribe = useCallback((handler: WsHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  return <WebSocketContext.Provider value={{ connected, send, subscribe }}>{children}</WebSocketContext.Provider>;
}

export function useWebSocket(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within WebSocketProvider');
  return ctx;
}
