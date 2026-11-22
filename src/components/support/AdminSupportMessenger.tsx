import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Archive, CheckCircle2, RotateCcw, Send, Trash2 } from 'lucide-react';
import { ApiError, apiFetch } from '../../lib/api';
import { supportStatusBadgeClass, supportStatusMessageClass } from '../../lib/supportStatusMessages';
import { AlertBanner, Button, submitFormOnEnter } from '../ui/Primitives';

interface AdminTicket {
  id: string;
  source: 'support' | 'contact';
  subject: string;
  user_email: string;
  contact_name: string;
  status: string;
  unread_count: number;
  last_message: string | null;
  archived_at: string | null;
}

interface AdminSupportMessage {
  id: string;
  sender_id: string | null;
  is_staff: number;
  content: string;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  new: 'En cours',
  open: 'Ouvert',
  in_progress: 'En cours',
  waiting_customer: 'En attente',
  resolved: 'Résolu',
  closed: 'Clôturé',
};

function ticketKey(ticket: Pick<AdminTicket, 'source' | 'id'>): string {
  return `${ticket.source}:${ticket.id}`;
}

function messageWasSavedDespiteResponseError(error: unknown): boolean {
  if (!(error instanceof ApiError) || typeof error.data !== 'object' || error.data === null) return false;
  return 'messageSaved' in error.data && error.data.messageSaved === true;
}

export function AdminSupportMessenger({ onRead }: { onRead: () => void }) {
  const location = useLocation();
  const requestedTicket = (location.state as { supportTicket?: { source: string; id: string } } | null)?.supportTicket;
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(
    requestedTicket ? `${requestedTicket.source}:${requestedTicket.id}` : null
  );
  const [messages, setMessages] = useState<AdminSupportMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const selectedTicket = tickets.find((ticket) => ticketKey(ticket) === selectedKey) || null;

  const refreshTickets = async () => {
    const data = await apiFetch<{ tickets: AdminTicket[] }>(
      `/api/admin/support?archived=${showArchived ? 'true' : 'false'}`
    );
    setTickets(data.tickets);
    setSelectedKey((current) => {
      const requestKey = requestedTicket ? `${requestedTicket.source}:${requestedTicket.id}` : null;
      if (requestKey && data.tickets.some((ticket) => ticketKey(ticket) === requestKey)) return requestKey;
      if (current && data.tickets.some((ticket) => ticketKey(ticket) === current)) return current;
      return data.tickets[0] ? ticketKey(data.tickets[0]) : null;
    });
  };

  const refreshMessages = async (ticket: AdminTicket) => {
    const data = await apiFetch<{ messages: AdminSupportMessage[] }>(
      `/api/admin/support/${ticket.source}/${ticket.id}/messages`
    );
    setMessages(data.messages);
    window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    onRead();
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await apiFetch<{ tickets: AdminTicket[] }>(
          `/api/admin/support?archived=${showArchived ? 'true' : 'false'}`
        );
        if (!active) return;
        setTickets(data.tickets);
        const requestKey = requestedTicket ? `${requestedTicket.source}:${requestedTicket.id}` : null;
        setSelectedKey((current) => {
          if (requestKey && data.tickets.some((ticket) => ticketKey(ticket) === requestKey)) return requestKey;
          if (current && data.tickets.some((ticket) => ticketKey(ticket) === current)) return current;
          return data.tickets[0] ? ticketKey(data.tickets[0]) : null;
        });
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Impossible de charger la Messagerie support');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [showArchived, requestedTicket?.source, requestedTicket?.id]);

  useEffect(() => {
    if (!selectedTicket) {
      setMessages([]);
      return;
    }
    let active = true;
    const load = async (openSelectedTicket = false) => {
      try {
        if (openSelectedTicket && !showArchived) {
          try {
            await apiFetch(`/api/admin/support/${selectedTicket.source}/${selectedTicket.id}/status`, {
              method: 'PATCH',
              body: JSON.stringify({ status: 'open' }),
            });
            const ticketData = await apiFetch<{ tickets: AdminTicket[] }>(
              `/api/admin/support?archived=${showArchived ? 'true' : 'false'}`
            );
            if (active) setTickets(ticketData.tickets);
          } catch (err) {
            if (active) setError(err instanceof Error ? err.message : 'Impossible d’ouvrir le ticket');
          }
        }
        const data = await apiFetch<{ messages: AdminSupportMessage[] }>(
          `/api/admin/support/${selectedTicket.source}/${selectedTicket.id}/messages`
        );
        if (active) {
          setMessages(data.messages);
          onRead();
          try {
            const ticketData = await apiFetch<{ tickets: AdminTicket[] }>(
              `/api/admin/support?archived=${showArchived ? 'true' : 'false'}`
            );
            if (active) setTickets(ticketData.tickets);
          } catch (err) {
            if (active) {
              setError(err instanceof Error
                ? `Discussion ouverte, mais impossible d’actualiser les notifications : ${err.message}`
                : 'Discussion ouverte, mais impossible d’actualiser les notifications.');
            }
          }
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Impossible de charger la discussion');
      }
    };
    void load(true);
    const interval = window.setInterval(() => {
      void load(false);
    }, 20_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [selectedKey, selectedTicket?.source, selectedTicket?.id, showArchived]);

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedTicket || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/support/${selectedTicket.source}/${selectedTicket.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: draft.trim() }),
      });
      setDraft('');
      try {
        await refreshTickets();
        await refreshMessages(selectedTicket);
      } catch (err) {
        setError(err instanceof Error ? `Message envoyé, mais l’actualisation a échoué : ${err.message}` : 'Message envoyé, mais impossible d’actualiser la discussion.');
      }
    } catch (err) {
      if (messageWasSavedDespiteResponseError(err)) {
        setDraft('');
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Impossible d’envoyer la réponse');
      }
      try {
        await refreshTickets();
        await refreshMessages(selectedTicket);
      } catch {
        setError((current) => `${current || 'Message enregistré.'} L’actualisation de la discussion a également échoué.`);
      }
    } finally {
      setSending(false);
    }
  };

  const changeStatus = async (status: 'in_progress' | 'resolved' | 'closed') => {
    if (!selectedTicket || processing) return;
    setProcessing(status);
    setError(null);
    try {
      await apiFetch(`/api/admin/support/${selectedTicket.source}/${selectedTicket.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await refreshTickets();
      await refreshMessages(selectedTicket);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de mettre à jour le ticket');
      try {
        await refreshTickets();
        await refreshMessages(selectedTicket);
      } catch {
        setError((current) => `${current || 'Échec de la mise à jour.'} L’actualisation de la discussion a également échoué.`);
      }
    } finally {
      setProcessing(null);
    }
  };

  const archiveTicket = async () => {
    if (!selectedTicket || processing) return;
    if (!window.confirm('Archiver cette demande ? Son historique sera conservé et pourra être restauré.')) return;
    setProcessing('archive');
    setError(null);
    try {
      await apiFetch(`/api/admin/support/${selectedTicket.source}/${selectedTicket.id}`, { method: 'DELETE' });
      await refreshTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible d’archiver cette demande');
    } finally {
      setProcessing(null);
    }
  };

  const restoreTicket = async () => {
    if (!selectedTicket || processing) return;
    setProcessing('restore');
    setError(null);
    try {
      await apiFetch(`/api/admin/support/${selectedTicket.source}/${selectedTicket.id}/restore`, { method: 'POST' });
      await refreshTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de restaurer cette demande');
    } finally {
      setProcessing(null);
    }
  };

  const permanentlyDeleteTicket = async () => {
    if (!selectedTicket || !selectedTicket.archived_at || processing) return;
    if (!window.confirm('Supprimer définitivement cette demande et tout son historique ? Cette action est irréversible.')) return;
    setProcessing('delete');
    setError(null);
    try {
      await apiFetch(`/api/admin/support/${selectedTicket.source}/${selectedTicket.id}/permanent`, { method: 'DELETE' });
      try {
        await refreshTickets();
      } catch (err) {
        setError(err instanceof Error
          ? `Demande supprimée, mais impossible d’actualiser la liste : ${err.message}`
          : 'Demande supprimée, mais impossible d’actualiser la liste.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de supprimer définitivement cette demande');
    } finally {
      setProcessing(null);
    }
  };

  if (loading) {
    return <div className="rounded-lg border border-[#25263A]/10 bg-white p-8 text-sm text-[#64667A]">Chargement de la Messagerie support...</div>;
  }

  return (
    <div className="space-y-4">
      {error && <AlertBanner tone="error">{error}</AlertBanner>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl text-[#101323]">Messagerie Support</h2>
          <p className="mt-1 text-sm text-[#64667A]">
            Répondez ici : vos messages sont visibles dans l’espace Assistance du client.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => setShowArchived((value) => !value)}>
          <Archive className="h-4 w-4" />
          {showArchived ? 'Voir les demandes actives' : 'Voir les demandes archivées'}
        </Button>
      </div>

      <div className="grid min-h-[560px] grid-cols-1 overflow-hidden rounded-lg border border-[#25263A]/10 bg-white lg:grid-cols-12">
        <aside className="border-b border-[#25263A]/10 bg-[#F7F4EF]/40 lg:col-span-4 lg:border-b-0 lg:border-e">
          <div className="border-b border-[#25263A]/10 px-4 py-3 text-sm font-medium text-[#101323]">
            {showArchived ? 'Archivés' : 'Demandes'} ({tickets.length})
          </div>
          <div className="max-h-[560px] divide-y divide-[#25263A]/10 overflow-y-auto">
            {tickets.map((ticket) => (
              <button
                key={ticketKey(ticket)}
                type="button"
                onClick={() => setSelectedKey(ticketKey(ticket))}
                className={`w-full px-4 py-3.5 text-start transition-colors ${selectedKey === ticketKey(ticket) ? 'bg-white' : 'hover:bg-white/60'}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-[#101323]">{ticket.subject}</span>
                  {ticket.unread_count > 0 && (
                    <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                      {ticket.unread_count}
                    </span>
                  )}
                </span>
                <span className="mt-1 block truncate text-xs text-[#64667A]">{ticket.contact_name} · {ticket.user_email}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className={`inline-flex w-fit rounded px-2 py-0.5 text-xs font-medium text-white ${supportStatusBadgeClass(ticket.status)}`}>
                    {STATUS_LABELS[ticket.status] || ticket.status}
                  </span>
                  <span className="text-xs text-[#64667A]">
                    · {ticket.source === 'contact' ? 'Formulaire de contact' : 'Ticket client'}
                  </span>
                </span>
                {ticket.last_message && <span className="mt-1.5 block truncate text-xs text-[#64667A]">{ticket.last_message}</span>}
              </button>
            ))}
            {tickets.length === 0 && (
              <div className="p-5 text-sm text-[#64667A]">
                {showArchived ? 'Aucune demande archivée.' : 'Aucune nouvelle demande support.'}
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-[560px] flex-col lg:col-span-8">
          {selectedTicket ? (
            <>
              <div className="space-y-3 border-b border-[#25263A]/10 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-serif text-xl text-[#101323]">{selectedTicket.subject}</h3>
                    <div className="mt-1 text-xs text-[#64667A]">{selectedTicket.contact_name} · {selectedTicket.user_email}</div>
                    <div className="mt-1">
                      <span className={`inline-flex w-fit rounded px-2 py-0.5 text-xs font-medium text-white ${supportStatusBadgeClass(selectedTicket.status)}`}>
                        {STATUS_LABELS[selectedTicket.status] || selectedTicket.status}
                      </span>
                    </div>
                  </div>
                  {selectedTicket.archived_at ? (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={processing !== null} onClick={restoreTicket}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        Restaurer
                      </Button>
                      <Button size="sm" variant="danger" disabled={processing !== null} onClick={permanentlyDeleteTicket}>
                        <Trash2 className="h-3.5 w-3.5" />
                        Supprimer définitivement
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={processing !== null || selectedTicket.status === 'in_progress'} onClick={() => changeStatus('in_progress')}>
                        En cours
                      </Button>
                      <Button size="sm" variant="outline" disabled={processing !== null || selectedTicket.status === 'resolved'} onClick={() => changeStatus('resolved')}>
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Valider
                      </Button>
                      <Button size="sm" variant="outline" disabled={processing !== null || selectedTicket.status === 'closed'} onClick={() => changeStatus('closed')}>
                        Clore
                      </Button>
                      <Button size="sm" variant="danger" disabled={processing !== null} onClick={archiveTicket}>
                        <Trash2 className="h-3.5 w-3.5" />
                        Supprimer
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              <div className="max-h-[400px] flex-1 space-y-4 overflow-y-auto bg-[#F7F4EF]/30 p-5">
                {messages.map((message) => (
                  <div key={message.id} className={`flex flex-col ${message.is_staff ? 'items-end' : 'items-start'}`}>
                    <div className={`max-w-[85%] break-words whitespace-pre-wrap rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                      message.is_staff
                        ? supportStatusMessageClass(message.content) || 'bg-[#101323] text-[#F7F4EF]'
                        : 'border border-[#25263A]/10 bg-white text-[#25263A]'
                    }`}>
                      <div className="mb-1 text-[11px] font-semibold opacity-70">
                        {message.is_staff ? 'Équipe Support' : selectedTicket.contact_name}
                      </div>
                      {message.content}
                    </div>
                    <span className="mt-1 text-[11px] text-[#64667A]">
                      {new Date(message.created_at).toLocaleString('fr-FR')}
                    </span>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              {selectedTicket.archived_at ? (
                <div className="border-t border-[#25263A]/10 bg-[#F7F4EF] px-5 py-3 text-xs text-[#64667A]">
                  Cette demande est archivée.
                </div>
              ) : (
                <form onSubmit={handleSend} className="flex items-end gap-3 border-t border-[#25263A]/10 bg-white p-4">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={submitFormOnEnter}
                    placeholder="Répondre au ticket..."
                    maxLength={4000}
                    rows={2}
                    disabled={sending}
                    className="min-h-[42px] flex-1 resize-y rounded-md border border-[#25263A]/20 px-3.5 py-2 text-sm focus:border-[#C7A66A] focus:outline-none"
                  />
                  <Button type="submit" disabled={sending || !draft.trim()}>
                    <Send className="h-4 w-4" />
                    Envoyer
                  </Button>
                </form>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-[#64667A]">
              Sélectionnez une demande pour ouvrir la discussion.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
