import React, { useEffect, useRef, useState } from 'react';
import { Send, Flag, CheckCircle2, Wifi, WifiOff } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useWebSocket } from '../../context/WebSocketContext';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';
import type { ChatConversation, ChatMessage } from '../../types';
import { AlertBanner, Button, EmptyState, Modal, Textarea, submitFormOnEnter } from '../ui/Primitives';

export function ChatWorkspace({ mode }: { mode: 'client' | 'expert' }) {
  const { user } = useAuth();
  const { connected, send, subscribe } = useWebSocket();
  const { formatCurrency } = useI18n();
  const apiBase = mode === 'expert' ? '/api/expert' : '/api/client';

  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportSuccess, setReportSuccess] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const selectedConv = conversations.find((c) => c.id === selectedId) || null;

  const loadConversations = async () => {
    try {
      const data = await apiFetch<{ conversations: ChatConversation[] }>(`${apiBase}/conversations`);
      setConversations(data.conversations);
      if (!selectedId && data.conversations.length > 0) {
        setSelectedId(data.conversations[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de charger les conversations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConversations();
  }, [apiBase]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;

    apiFetch<{ messages: ChatMessage[] }>(`${apiBase}/conversations/${selectedId}/messages`)
      .then((data) => {
        if (!cancelled) {
          setMessages(data.messages);
          setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Impossible de charger les messages');
      });

    send({ action: 'join_conversation', conversationId: selectedId });

    return () => {
      cancelled = true;
      send({ action: 'leave_conversation', conversationId: selectedId });
    };
  }, [selectedId, apiBase, send]);

  useEffect(() => {
    return subscribe((event, payload) => {
      if (event === 'message:created') {
        const msg = payload as ChatMessage;
        if (msg.conversation_id === selectedId) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
          setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        }
        loadConversations();
      } else if (event === 'error') {
        const p = payload as { message?: string };
        if (p?.message) setError(p.message);
      }
    });
  }, [subscribe, selectedId]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || !draft.trim() || sending) return;
    setError(null);
    setSending(true);
    try {
      const res = await apiFetch<{ message: ChatMessage }>(`${apiBase}/conversations/${selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: draft.trim() }),
      });
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      setDraft('');
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      loadConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de l’envoi du message');
    } finally {
      setSending(false);
    }
  };

  const handleEndConsultation = async () => {
    if (!selectedConv?.consultation_id) return;
    setError(null);
    try {
      const endpoint =
        mode === 'expert'
          ? `/api/expert/consultations/${selectedConv.consultation_id}/complete`
          : `/api/client/consultations/${selectedConv.consultation_id}/end`;
      await apiFetch(endpoint, { method: 'POST' });
      await loadConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de clôturer la consultation');
    }
  };

  const handleReportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || reportReason.trim().length < 5) return;
    try {
      await apiFetch(`/api/client/conversations/${selectedId}/report`, {
        method: 'POST',
        body: JSON.stringify({ reason: reportReason }),
      });
      setReportSuccess(true);
      setReportReason('');
      setTimeout(() => {
        setReportOpen(false);
        setReportSuccess(false);
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible d’envoyer le signalement');
    }
  };

  if (loading) {
    return <div className="rounded-lg border border-[#25263A]/10 bg-white p-8 text-sm text-[#64667A]">Chargement des conversations...</div>;
  }

  if (conversations.length === 0) {
    return (
      <EmptyState
        title="Aucune consultation active"
        description={
          mode === 'client'
            ? 'Démarrez une séance de tchat en direct depuis le profil d’un conseiller pour échanger en temps réel.'
            : 'Les conversations clients apparaîtront ici dès qu’une séance sera initiée.'
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && <AlertBanner tone="error">{error}</AlertBanner>}

      <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-[#25263A]/10 bg-white lg:grid-cols-12 min-h-[600px]">
        {/* Liste des conversations */}
        <aside className="border-b lg:border-b-0 lg:border-e border-[#25263A]/10 lg:col-span-4 bg-[#F7F4EF]/40">
          <div className="flex items-center justify-between border-b border-[#25263A]/10 px-4 py-3 text-xs text-[#64667A]">
            <span className="font-medium text-[#101323]">Conversations ({conversations.length})</span>
            <span className="inline-flex items-center gap-1.5">
              {connected ? (
                <>
                  <Wifi className="h-3.5 w-3.5 text-[#166534]" />
                  <span className="text-[#166534]">En direct</span>
                </>
              ) : (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-[#92400E]" />
                  <span>Reconnexion</span>
                </>
              )}
            </span>
          </div>
          <div className="divide-y divide-[#25263A]/10 max-h-[540px] overflow-y-auto">
            {conversations.map((conv) => {
              const title = mode === 'expert' ? conv.client_name : conv.expert_name;
              const active = conv.id === selectedId;
              const statusFr =
                (conv.consultation_status || conv.status) === 'active'
                  ? 'Active'
                  : (conv.consultation_status || conv.status) === 'completed'
                  ? 'Terminée'
                  : (conv.consultation_status || conv.status) === 'closed'
                  ? 'Clôturée'
                  : 'Ouverte';

              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => setSelectedId(conv.id)}
                  className={`w-full text-start px-4 py-3.5 transition-colors ${
                    active ? 'bg-white' : 'hover:bg-white/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm text-[#101323] truncate">{title || 'Consultation'}</span>
                    {Number(conv.unread_count) > 0 && (
                      <span className="font-mono text-xs font-semibold text-[#C7A66A] tabular-nums">{conv.unread_count} nouv.</span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-[#64667A]">
                    <span>{statusFr}</span>
                    {conv.billing_model && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {formatCurrency(conv.unit_price_cents ?? 0)}
                          {conv.billing_model === 'per_message' ? '/msg' : conv.billing_model === 'per_minute' ? '/min' : '/séance'}
                        </span>
                      </>
                    )}
                  </div>
                  {conv.last_message && (
                    <p className="mt-1.5 truncate text-xs text-[#64667A]">{conv.last_message}</p>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Fenêtre de discussion active */}
        <section className="flex flex-col lg:col-span-8">
          {selectedConv && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#25263A]/10 px-5 py-3.5 bg-white">
                <div>
                  <div className="font-serif text-xl font-medium text-[#101323]">
                    {mode === 'expert' ? selectedConv.client_name : selectedConv.expert_name}
                  </div>
                  <div className="text-xs text-[#64667A] flex flex-wrap items-center gap-2">
                    <span>
                      Statut :{' '}
                      {(selectedConv.consultation_status || selectedConv.status) === 'active'
                        ? 'En cours'
                        : (selectedConv.consultation_status || selectedConv.status) === 'completed'
                        ? 'Terminée'
                        : 'Clôturée'}
                    </span>
                    {selectedConv.billing_model && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          Tarif : {formatCurrency(selectedConv.unit_price_cents ?? 0)}
                        </span>
                      </>
                    )}
                    {selectedConv.gross_amount_cents !== undefined && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          Total séance : {formatCurrency(selectedConv.gross_amount_cents)}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {mode === 'client' && (
                    <Button variant="ghost" size="sm" onClick={() => setReportOpen(true)}>
                      <Flag className="h-3.5 w-3.5" />
                      Signaler
                    </Button>
                  )}
                  {selectedConv.consultation_status === 'active' && (
                    <Button variant="outline" size="sm" onClick={handleEndConsultation}>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Terminer &amp; Régler
                    </Button>
                  )}
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 space-y-4 overflow-y-auto bg-[#F7F4EF]/30 p-5 max-h-[460px]">
                {messages.map((m) => {
                  const mine = m.sender_id === user?.id;
                  return (
                    <div key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                      <div
                        className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                          mine
                            ? 'bg-[#101323] text-[#F7F4EF]'
                            : 'border border-[#25263A]/10 bg-white text-[#25263A]'
                        }`}
                      >
                        {m.content}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-[#64667A] font-mono tabular-nums">
                        <span>{new Date(m.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                        {m.billed_cents > 0 && <span>· Facturé {formatCurrency(m.billed_cents)}</span>}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Saisie */}
              {selectedConv.status === 'open' ? (
                <form onSubmit={handleSend} className="border-t border-[#25263A]/10 bg-white p-4 flex items-center gap-3">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={submitFormOnEnter}
                    placeholder="Écrivez votre message..."
                    maxLength={4000}
                    rows={2}
                    disabled={sending}
                    className="flex-1 min-h-[42px] resize-none rounded-md border border-[#25263A]/20 px-3.5 py-2 text-sm focus:border-[#C7A66A] focus:outline-none disabled:cursor-not-allowed disabled:bg-[#F7F4EF]"
                  />
                  <Button type="submit" disabled={sending || !draft.trim()}>
                    <Send className="h-4 w-4" />
                    Envoyer
                  </Button>
                </form>
              ) : (
                <div className="border-t border-[#25263A]/10 bg-[#F7F4EF] px-5 py-3 text-xs text-[#64667A]">
                  Cette séance de consultation a été finalisée et archivée.
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <Modal open={reportOpen} onClose={() => setReportOpen(false)} title="Signaler la conversation">
        {reportSuccess ? (
          <AlertBanner tone="success">Votre signalement a bien été transmis à l’équipe de modération.</AlertBanner>
        ) : (
          <form onSubmit={handleReportSubmit} className="space-y-4">
            <Textarea
              label="Motif du signalement"
              rows={4}
              required
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              placeholder="Décrivez le problème rencontré..."
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setReportOpen(false)}>
                Annuler
              </Button>
              <Button type="submit">Envoyer le signalement</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
