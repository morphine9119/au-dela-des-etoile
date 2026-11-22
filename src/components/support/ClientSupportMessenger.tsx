import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { supportStatusBadgeClass, supportStatusMessageClass } from '../../lib/supportStatusMessages';
import { AlertBanner, Button, EmptyState, submitFormOnEnter } from '../ui/Primitives';

interface SupportTicket {
  id: string;
  source: 'support' | 'contact';
  subject: string;
  status: string;
  created_at: string;
  updated_at: string;
  has_staff_reply: number;
}

interface SupportMessage {
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
  waiting_customer: 'En attente de votre réponse',
  resolved: 'Résolu',
  closed: 'Clôturé',
};

function ticketKey(ticket: Pick<SupportTicket, 'source' | 'id'>): string {
  return `${ticket.source}:${ticket.id}`;
}

export function ClientSupportMessenger({ onRead }: { onRead: () => void }) {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const selectedTicket = tickets.find((ticket) => ticketKey(ticket) === selectedKey) || null;
  const selectedTicketIsClosed = selectedTicket?.status === 'resolved' || selectedTicket?.status === 'closed';

  const refreshTickets = async () => {
    const data = await apiFetch<{ tickets: SupportTicket[] }>('/api/client/support/inbox');
    setTickets(data.tickets);
    setError(null);
    setSelectedKey((current) => {
      if (current && data.tickets.some((ticket) => ticketKey(ticket) === current)) {
        return current;
      }
      const nextTicket = data.tickets[0];
      return nextTicket ? ticketKey(nextTicket) : null;
    });
  };

  useEffect(() => {
    let active = true;
    apiFetch<{ tickets: SupportTicket[] }>('/api/client/support/inbox')
      .then(({ tickets: nextTickets }) => {
        if (!active) return;
        setTickets(nextTickets);
        setSelectedKey(nextTickets[0] ? ticketKey(nextTickets[0]) : null);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Impossible de charger les demandes support');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshTickets().catch((err) => {
        setError(err instanceof Error ? err.message : 'Impossible d’actualiser les demandes support');
      });
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedTicket) {
      setMessages([]);
      return;
    }
    let active = true;
    const messagesUrl = selectedTicket.source === 'contact'
      ? `/api/client/support/contact/${selectedTicket.id}/messages`
      : `/api/client/support/${selectedTicket.id}/messages`;
    const loadMessages = async () => {
      try {
        const { messages: nextMessages } = await apiFetch<{ messages: SupportMessage[] }>(messagesUrl);
        if (!active) return;
        setMessages(nextMessages);
        window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
        try {
          await refreshTickets();
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : 'Impossible d’actualiser les demandes support');
        }
        onReadRef.current();
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Impossible de charger les messages support');
      }
    };
    void loadMessages();
    const interval = window.setInterval(() => {
      void loadMessages();
    }, 20_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [selectedKey]);

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedTicket || selectedTicketIsClosed || selectedTicket.has_staff_reply !== 1 || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const messagesUrl = selectedTicket.source === 'contact'
        ? `/api/client/support/contact/${selectedTicket.id}/messages`
        : `/api/client/support/${selectedTicket.id}/messages`;
      await apiFetch(messagesUrl, {
        method: 'POST',
        body: JSON.stringify({ content: draft.trim() }),
      });
      setDraft('');
      const { messages: nextMessages } = await apiFetch<{ messages: SupportMessage[] }>(
        messagesUrl
      );
      setMessages(nextMessages);
      window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      await refreshTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible d’envoyer le message');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 text-sm text-[#64667A]">Chargement des demandes support...</div>;
  }
  if (tickets.length === 0) {
    return (
      <div className="space-y-3">
        {error && <AlertBanner tone="error">{error}</AlertBanner>}
        <EmptyState
          title="Aucune discussion avec le support"
          description="Vos échanges liés à un ticket apparaîtront ici."
        />
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void refreshTickets().catch((err) => {
                setError(err instanceof Error ? err.message : 'Impossible d’actualiser les demandes support');
              });
            }}
          >
            Actualiser
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="font-serif text-2xl text-[#101323]">Discussions avec le support</h2>
      {error && <AlertBanner tone="error">{error}</AlertBanner>}
      <div className="grid min-h-[420px] grid-cols-1 overflow-hidden rounded-lg border border-[#25263A]/10 bg-white lg:grid-cols-12">
        <aside className="border-b border-[#25263A]/10 bg-[#F7F4EF]/40 lg:col-span-4 lg:border-b-0 lg:border-e">
          <div className="border-b border-[#25263A]/10 px-4 py-3 text-sm font-medium text-[#101323]">
            Tickets ({tickets.length})
          </div>
          <div className="max-h-[420px] divide-y divide-[#25263A]/10 overflow-y-auto">
            {tickets.map((ticket) => (
              <button
                key={ticket.id}
                type="button"
                onClick={() => setSelectedKey(ticketKey(ticket))}
                className={`w-full px-4 py-3.5 text-start transition-colors ${selectedKey === ticketKey(ticket) ? 'bg-white' : 'hover:bg-white/60'}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-[#101323]">{ticket.subject}</span>
                </span>
                <span className={`mt-1 inline-flex w-fit rounded px-2 py-0.5 text-xs font-medium text-white ${supportStatusBadgeClass(ticket.status)}`}>
                  {STATUS_LABELS[ticket.status] || ticket.status}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="flex min-h-[420px] flex-col lg:col-span-8">
          {selectedTicket && (
            <>
              <div className="border-b border-[#25263A]/10 px-5 py-3.5">
                <div className="font-serif text-xl text-[#101323]">{selectedTicket.subject}</div>
                <div className="mt-1">
                  <span className={`inline-flex w-fit rounded px-2 py-0.5 text-xs font-medium text-white ${supportStatusBadgeClass(selectedTicket.status)}`}>
                    {STATUS_LABELS[selectedTicket.status] || selectedTicket.status}
                  </span>
                </div>
              </div>
              <div className="max-h-[330px] flex-1 space-y-3 overflow-y-auto bg-[#F7F4EF]/30 p-5">
                {messages.map((message) => (
                  <div key={message.id} className={`flex flex-col ${message.is_staff ? 'items-start' : 'items-end'}`}>
                    <div className={`max-w-[85%] break-words whitespace-pre-wrap rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                      message.is_staff
                        ? supportStatusMessageClass(message.content) || 'border border-[#25263A]/10 bg-white text-[#25263A]'
                        : 'bg-[#101323] text-[#F7F4EF]'
                    }`}>
                      <div className="mb-1 text-[11px] font-semibold opacity-70">{message.is_staff ? 'Équipe Support' : 'Vous'}</div>
                      {message.content}
                    </div>
                    <span className="mt-1 text-[11px] text-[#64667A]">
                      {new Date(message.created_at).toLocaleString('fr-FR')}
                    </span>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              {selectedTicketIsClosed ? (
                <div className="border-t border-[#25263A]/10 bg-[#F7F4EF] px-5 py-3 text-xs text-[#64667A]">
                  {selectedTicket.status === 'resolved'
                    ? 'Cette discussion est résolue. Vous pouvez consulter les messages précédents.'
                    : 'Cette discussion est clôturée. Ouvrez un nouveau ticket pour contacter le support.'}
                </div>
              ) : (
                <form onSubmit={handleSend} className="flex items-end gap-3 border-t border-[#25263A]/10 bg-white p-4">
                  <div className="min-w-0 flex-1">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={submitFormOnEnter}
                      disabled={selectedTicket.has_staff_reply !== 1 || sending}
                      placeholder={selectedTicket.has_staff_reply === 1 ? 'Écrivez votre message...' : "En attente de l'assistance du support."}
                      maxLength={4000}
                      rows={2}
                      className="min-h-[42px] w-full resize-none rounded-md border border-[#25263A]/20 px-3.5 py-2 text-sm focus:border-[#C7A66A] focus:outline-none disabled:cursor-not-allowed disabled:bg-[#F7F4EF] disabled:text-[#64667A]"
                    />
                    <p className="mt-1 text-[11px] text-[#64667A]">
                      {selectedTicket.has_staff_reply === 1
                        ? 'Vous pouvez répondre à l’équipe.'
                        : 'Veuillez patienter jusqu’à ce qu’un membre de notre équipe d’assistance vous réponde.'}
                    </p>
                  </div>
                  <Button type="submit" disabled={sending || selectedTicket.has_staff_reply !== 1 || !draft.trim()}>
                    <Send className="h-4 w-4" />
                    Envoyer
                  </Button>
                </form>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
