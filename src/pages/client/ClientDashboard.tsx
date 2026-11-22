import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Heart,
  LifeBuoy,
  Settings,
  Clock,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';
import { ChatWorkspace } from '../../components/chat/ChatWorkspace';
import { ClientSupportMessenger } from '../../components/support/ClientSupportMessenger';
import { ExpertCard } from '../../components/experts/ExpertCard';
import { DashboardShell, type NavItem } from '../../components/layout/DashboardShell';
import { AlertBanner, Button, EmptyState, Input, Modal, Select, Textarea } from '../../components/ui/Primitives';
import type { ExpertProfile } from '../../types';

const ROUTE_TO_TAB: Record<string, string> = {
  '/account/messages': 'messages',
  '/account/appointments': 'appointments',
  '/account/consultations': 'consultations',
  '/account/wallet': 'wallet',
  '/account/transactions': 'wallet',
  '/account/favorites': 'favorites',
  '/account/rewards': 'rewards',
  '/account/notifications': 'notifications',
  '/account/support': 'support',
  '/account/profile': 'settings',
  '/account/settings': 'settings',
};

const STATUS_FR: Record<string, string> = {
  active: 'En cours',
  pending: 'En attente',
  completed: 'Terminée',
  confirmed: 'Confirmé',
  rescheduled: 'Replanifié',
  cancelled: 'Annulé',
  open: 'Ouvert',
  resolved: 'Résolu',
  waiting_customer: 'En attente client',
  in_progress: 'En traitement',
};

const TIER_FR: Record<string, string> = {
  silver: 'ARGENT',
  gold: 'OR',
  celestial: 'CÉLESTE',
};

export function ClientDashboard() {
  const { user, refreshUser, logout } = useAuth();
  const { formatCurrency, formatDate } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  const activeTab = ROUTE_TO_TAB[location.pathname] || 'favorites';
  const setTab = (id: string) => {
    navigate(`/account/${id}`);
  };

  const [dash, setDash] = useState<Record<string, unknown> | null>(null);
  const [consultations, setConsultations] = useState<Array<Record<string, unknown>>>([]);
  const [appointments, setAppointments] = useState<Array<Record<string, unknown>>>([]);
  const [favorites, setFavorites] = useState<ExpertProfile[]>([]);
  const [walletData, setWalletData] = useState<Record<string, unknown> | null>(null);
  const [rewardsData, setRewardsData] = useState<Record<string, unknown> | null>(null);
  const [notifications, setNotifications] = useState<Array<Record<string, unknown>>>([]);
  const unreadNotificationCount = notifications.filter((notification) => !notification.is_read).length;
  const [unreadSupportCount, setUnreadSupportCount] = useState(0);
  const [supportReplyNotification, setSupportReplyNotification] = useState<Record<string, unknown> | null>(null);
  const seenNotificationIds = useRef(new Set<string>());
  const notificationsLoaded = useRef(false);
  const [country, setCountry] = useState('FR');
  const [topupAmount, setTopupAmount] = useState(2500);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Avis
  const [reviewConsultId, setReviewConsultId] = useState<string | null>(null);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');

  // Support
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketCategory, setTicketCategory] = useState('billing');
  const [ticketMsg, setTicketMsg] = useState('');
  const [submittingSupportTicket, setSubmittingSupportTicket] = useState(false);
  const [supportRefreshKey, setSupportRefreshKey] = useState(0);

  // Profil
  const [firstName, setFirstName] = useState(user?.profile?.first_name || '');
  const [lastName, setLastName] = useState(user?.profile?.last_name || '');
  const [phone, setPhone] = useState(user?.profile?.phone || '');
  const [timezone, setTimezone] = useState(user?.profile?.timezone || 'Europe/Paris');

  const loadAll = async () => {
    try {
      const [d, c, a, f, w, r, n] = await Promise.all([
        apiFetch<Record<string, unknown>>('/api/client/dashboard'),
        apiFetch<{ consultations: Array<Record<string, unknown>> }>('/api/client/consultations'),
        apiFetch<{ appointments: Array<Record<string, unknown>> }>('/api/client/appointments'),
        apiFetch<{ favorites: ExpertProfile[] }>('/api/client/favorites'),
        apiFetch<Record<string, unknown>>(`/api/client/wallet?country=${country}`),
        apiFetch<Record<string, unknown>>('/api/client/rewards'),
        apiFetch<{ notifications: Array<Record<string, unknown>> }>('/api/client/notifications'),
      ]);
      setDash(d);
      setConsultations(c.consultations);
      setAppointments(a.appointments);
      setFavorites(f.favorites);
      setWalletData(w);
      setRewardsData(r);
      setNotifications(n.notifications);
      seenNotificationIds.current = new Set(n.notifications.map((notification) => String(notification.id)));
      notificationsLoaded.current = true;
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de charger votre espace personnel' });
    }
  };

  const refreshUnreadMessages = async () => {
    try {
      const latest = await apiFetch<Record<string, unknown>>('/api/client/dashboard');
      setDash((current) => current ? { ...current, unreadMessages: latest.unreadMessages } : current);
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’actualiser les messages non lus' });
    }
  };

  const refreshUnreadSupport = async () => {
    try {
      const { tickets } = await apiFetch<{ tickets: Array<{ unread_count: number }> }>('/api/client/support/inbox');
      setUnreadSupportCount(tickets.reduce((total, ticket) => total + ticket.unread_count, 0));
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’actualiser les notifications d’assistance' });
    }
  };

  const handleSupportTicketSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingSupportTicket) return;
    setBanner(null);
    setSubmittingSupportTicket(true);
    try {
      await apiFetch('/api/client/support', {
        method: 'POST',
        body: JSON.stringify({
          subject: ticketSubject.trim(),
          category: ticketCategory,
          message: ticketMsg.trim(),
        }),
      });
      setTicketSubject('');
      setTicketMsg('');
      setSupportRefreshKey((key) => key + 1);
      setBanner({ tone: 'success', text: 'Ticket envoyé. Vous pouvez suivre la réponse de l’équipe ici.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’envoyer votre demande' });
    } finally {
      setSubmittingSupportTicket(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [country]);

  useEffect(() => {
    void refreshUnreadSupport();
    const interval = window.setInterval(() => {
      void refreshUnreadSupport();
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      apiFetch<{ notifications: Array<Record<string, unknown>> }>('/api/client/notifications')
        .then((response) => {
          if (notificationsLoaded.current) {
            const newSupportReply = response.notifications.find((notification) =>
              notification.type === 'support_reply' && !seenNotificationIds.current.has(String(notification.id))
            );
            if (newSupportReply) setSupportReplyNotification(newSupportReply);
          }
          seenNotificationIds.current = new Set(response.notifications.map((notification) => String(notification.id)));
          notificationsLoaded.current = true;
          setNotifications(response.notifications);
        })
        .catch((err) => {
          setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’actualiser les notifications' });
        });
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (user?.profile) {
      setFirstName(user.profile.first_name);
      setLastName(user.profile.last_name);
      setPhone(user.profile.phone || '');
      setTimezone(user.profile.timezone);
    }
  }, [user]);

  const navItems: NavItem[] = [
    { id: 'favorites', label: 'Conseillers Favoris', icon: <Heart className="h-4 w-4" /> },
    {
      id: 'support',
      label: 'Assistance',
      icon: <LifeBuoy className="h-4 w-4" />,
      badge: unreadSupportCount,
      badgeStyle: 'notification',
    },
    { id: 'settings', label: 'Profil & RGPD', icon: <Settings className="h-4 w-4" /> },
  ];

  const handleSandboxCredit = async () => {
    setBanner(null);
    try {
      await apiFetch('/api/client/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({
          amountCents: topupAmount,
          provider: 'sandbox_demo',
          countryCode: country,
          idempotencyKey: `sbx-${user?.id}-${Date.now()}`,
        }),
      });
      await Promise.all([loadAll(), refreshUser()]);
      setBanner({ tone: 'success', text: `Crédit de test de ${formatCurrency(topupAmount)} ajouté à votre portefeuille.` });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Erreur lors du rechargement' });
    }
  };

  const handleRemoveFavorite = async (expert: ExpertProfile) => {
    try {
      await apiFetch<{ favorited: boolean }>(`/api/client/favorites/${expert.id}`, { method: 'POST' });
      setFavorites((current) => current.filter((favorite) => favorite.id !== expert.id));
      setBanner({ tone: 'success', text: `${expert.display_name} a été retiré de vos favoris.` });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de retirer ce conseiller des favoris.' });
    }
  };

  const handleDailyClaim = async () => {
    setBanner(null);
    try {
      await apiFetch('/api/client/rewards/daily-claim', { method: 'POST' });
      await Promise.all([loadAll(), refreshUser()]);
      setBanner({ tone: 'success', text: '25 Points Astraux crédités sur votre compte fidélité.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de réclamer le bonus quotidien' });
    }
  };

  const handleRedeemCoupon = async (couponId: string) => {
    setBanner(null);
    try {
      const res = await apiFetch<{ code: string }>('/api/client/rewards/redeem-coupon', {
        method: 'POST',
        body: JSON.stringify({ couponId }),
      });
      await Promise.all([loadAll(), refreshUser()]);
      setBanner({ tone: 'success', text: `Code avantage ${res.code} débloqué ! Utilisez-le lors d’une réservation.` });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Échange impossible' });
    }
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewConsultId) return;
    try {
      await apiFetch('/api/client/reviews', {
        method: 'POST',
        body: JSON.stringify({ consultationId: reviewConsultId, rating: reviewRating, comment: reviewComment }),
      });
      setReviewConsultId(null);
      setReviewComment('');
      await loadAll();
      setBanner({ tone: 'success', text: 'Votre avis vérifié a bien été publié.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Échec de la publication de l’avis' });
    }
  };

  const handleCancelAppointment = async (id: string) => {
    try {
      await apiFetch(`/api/client/appointments/${id}/cancel`, { method: 'POST' });
      await Promise.all([loadAll(), refreshUser()]);
      setBanner({ tone: 'success', text: 'Rendez-vous annulé et montant remboursé le cas échéant.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Échec de l’annulation' });
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/client/profile', {
        method: 'PATCH',
        body: JSON.stringify({ firstName, lastName, phone, preferredLanguage: 'fr', timezone }),
      });
      await refreshUser();
      setBanner({ tone: 'success', text: 'Préférences du profil enregistrées.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’enregistrer le profil' });
    }
  };

  const wallet = (walletData?.wallet || dash?.wallet || user?.wallet) as { available_cents: number; pending_cents: number } | undefined;
  const loyalty = (rewardsData?.account || dash?.loyalty || user?.loyalty) as
    | { points_balance: number; lifetime_points: number; tier: string; referral_code: string }
    | undefined;

  return (
    <DashboardShell
      portalTitle="Espace Client"
      subtitle={user?.profile ? `${user.profile.first_name} ${user.profile.last_name}` : undefined}
      navItems={navItems}
      activeTab={activeTab}
      onSelectTab={setTab}
      headerActions={
        <div className="flex items-center gap-3">
          <Link to="/experts" className="rounded-md bg-[#101323] px-4 py-2 text-xs font-medium text-[#F7F4EF]">
            Consulter un Conseiller
          </Link>
        </div>
      }
    >
      <div className="space-y-6 w-full">
        {banner && <AlertBanner tone={banner.tone}>{banner.text}</AlertBanner>}
        {supportReplyNotification && (
          <AlertBanner tone="info">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium">{String(supportReplyNotification.title)}</div>
                <div className="mt-0.5">{String(supportReplyNotification.body)}</div>
              </div>
              <Link
                to="/account/support"
                onClick={() => setSupportReplyNotification(null)}
                className="shrink-0 font-medium underline underline-offset-2"
              >
                Voir la réponse
              </Link>
            </div>
          </AlertBanner>
        )}

        {/* MESSAGERIE */}
        {activeTab === 'messages' && (
          <div className="space-y-6">
            <ChatWorkspace mode="client" />
            <ClientSupportMessenger onRead={() => {
              void refreshUnreadMessages();
              void refreshUnreadSupport();
            }} />
          </div>
        )}

        {/* RENDEZ-VOUS */}
        {activeTab === 'appointments' && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white overflow-hidden">
            <div className="px-6 py-4 border-b border-[#25263A]/10 flex items-center justify-between">
              <h2 className="font-serif text-2xl font-medium text-[#101323]">Rendez-vous Planifiés</h2>
              <Link to="/experts" className="text-xs font-medium text-[#101323] hover:underline">
                Réserver une nouvelle séance →
              </Link>
            </div>
            {appointments.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="Aucun rendez-vous planifié"
                  description="Choisissez un conseiller et sélectionnez un créneau disponible pour réserver une séance."
                />
              </div>
            ) : (
              <div className="divide-y divide-[#25263A]/10">
                {appointments.map((a) => (
                  <div key={String(a.id)} className="px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="font-medium text-[#101323]">{String(a.service_title)}</div>
                      <div className="text-xs text-[#64667A]">
                        Conseiller : {String(a.expert_name)} ·{' '}
                        {new Date(String(a.scheduled_start)).toLocaleString('fr-FR', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}{' '}
                        · Statut : {STATUS_FR[String(a.status)] || String(a.status)}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="font-mono text-sm tabular-nums">{formatCurrency(Number(a.price_cents))}</span>
                      {a.status === 'confirmed' && (
                        <Button variant="outline" size="sm" onClick={() => handleCancelAppointment(String(a.id))}>
                          Annuler &amp; Rembourser
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CONSULTATIONS */}
        {activeTab === 'consultations' && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white overflow-hidden">
            <div className="px-6 py-4 border-b border-[#25263A]/10">
              <h2 className="font-serif text-2xl font-medium text-[#101323]">Historique des Consultations</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-start text-sm">
                <thead className="whitespace-nowrap border-b border-[#25263A]/10 bg-[#F7F4EF]/60 text-xs text-[#64667A]">
                  <tr>
                    <th className="px-6 py-3 text-start font-medium">Conseiller</th>
                    <th className="px-6 py-3 text-start font-medium">Service</th>
                    <th className="px-6 py-3 text-start font-medium">Statut</th>
                    <th className="px-6 py-3 text-end font-medium">Montant</th>
                    <th className="px-6 py-3 text-end font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#25263A]/10">
                  {consultations.map((c) => (
                    <tr key={String(c.id)}>
                      <td className="px-6 py-3.5 font-medium text-[#101323]">{String(c.expert_name)}</td>
                      <td className="px-6 py-3.5 text-[#64667A]">{String(c.service_title)}</td>
                      <td className="px-6 py-3.5 text-xs uppercase">{STATUS_FR[String(c.status)] || String(c.status)}</td>
                      <td className="px-6 py-3.5 text-end font-mono tabular-nums">{formatCurrency(Number(c.gross_amount_cents || 0))}</td>
                      <td className="px-6 py-3.5 text-end">
                        {c.status === 'completed' && !c.review_id ? (
                          <Button size="sm" variant="outline" onClick={() => setReviewConsultId(String(c.id))}>
                            Laisser un Avis
                          </Button>
                        ) : c.review_id ? (
                          <span className="text-xs text-[#64667A]">Avis publié</span>
                        ) : (
                          <button onClick={() => setTab('messages')} className="text-xs font-medium text-[#101323] hover:underline">
                            Ouvrir le Tchat
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* PORTEFEUILLE */}
        {activeTab === 'wallet' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="lg:col-span-5 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-5">
                <div>
                  <div className="text-xs uppercase tracking-widest text-[#C7A66A]">Fonds Disponibles</div>
                  <div className="mt-1 font-mono text-3xl font-semibold text-[#101323] tabular-nums">
                    {formatCurrency(wallet?.available_cents || 0)}
                  </div>
                </div>

                <Select label="Pays de Facturation (Disponibilité des Prestataires)" value={country} onChange={(e) => setCountry(e.target.value)}>
                  <option value="FR">France (FR)</option>
                  <option value="BE">Belgique (BE)</option>
                  <option value="CH">Suisse (CH)</option>
                  <option value="MA">Maroc (MA)</option>
                  <option value="CA">Canada (CA)</option>
                </Select>

                <div className="space-y-2">
                  <div className="text-xs font-medium text-[#25263A]">Prestataires de Paiement ({country})</div>
                  {((walletData?.providers as Array<{ id: string; name: string; isConfigured: boolean; setupRequirement: string }>) || []).map((p) => (
                    <div key={p.id} className="rounded-md border border-[#25263A]/10 p-3 text-xs space-y-1">
                      <div className="flex items-center justify-between font-medium text-[#101323]">
                        <span>{p.name}</span>
                        <span className={p.isConfigured ? 'text-[#166534]' : 'text-[#92400E]'}>
                          {p.isConfigured ? 'Configuré' : 'Non configuré'}
                        </span>
                      </div>
                      {!p.isConfigured && <div className="text-[#64667A]">{p.setupRequirement}</div>}
                    </div>
                  ))}
                </div>

                <div className="border-t border-[#25263A]/10 pt-4 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-[#C7A66A]">
                    Crédit de Test Sandbox (Développement)
                  </div>
                  <p className="text-xs text-[#64667A]">
                    Le paiement par carte réelle est désactivé tant que les clés API du prestataire ne sont pas configurées. Ajoutez un crédit de test ci-dessous.
                  </p>
                  <div className="flex items-center gap-2">
                    <select
                      value={topupAmount}
                      onChange={(e) => setTopupAmount(Number(e.target.value))}
                      className="min-h-[40px] rounded-md border border-[#25263A]/20 px-3 text-sm font-mono tabular-nums"
                    >
                      <option value={1500}>15,00 €</option>
                      <option value={2500}>25,00 €</option>
                      <option value={5000}>50,00 €</option>
                      <option value={10000}>100,00 €</option>
                    </select>
                    <Button onClick={handleSandboxCredit}>Ajouter un Crédit Test</Button>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-7 rounded-lg border border-[#25263A]/10 bg-white overflow-hidden">
                <div className="px-6 py-4 border-b border-[#25263A]/10">
                  <h2 className="font-serif text-2xl font-medium text-[#101323]">Grand Livre des Transactions</h2>
                </div>
                <div className="divide-y divide-[#25263A]/10 max-h-[480px] overflow-y-auto">
                  {((walletData?.transactions as Array<Record<string, unknown>>) || []).map((tx) => (
                    <div key={String(tx.id)} className="px-6 py-3.5 flex items-center justify-between gap-4 text-sm">
                      <div>
                        <div className="font-medium text-[#101323]">{String(tx.description)}</div>
                        <div className="text-xs text-[#64667A]">
                          {String(tx.type)} · {formatDate(String(tx.created_at))}
                        </div>
                      </div>
                      <div className="text-end font-mono tabular-nums">
                        <div className={Number(tx.amount_cents) >= 0 ? 'text-[#166534]' : 'text-[#25263A]'}>
                          {Number(tx.amount_cents) >= 0 ? '+' : ''}
                          {formatCurrency(Number(tx.amount_cents))}
                        </div>
                        <div className="text-[11px] text-[#64667A]">Solde : {formatCurrency(Number(tx.balance_after_cents))}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* FAVORIS */}
        {activeTab === 'favorites' &&
          (favorites.length === 0 ? (
            <EmptyState
              title="Aucun conseiller favori"
              description="Ajoutez des spécialistes en favoris depuis l’annuaire pour retrouver rapidement leurs disponibilités."
            />
          ) : (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3 xl:grid-cols-4">
              {favorites.map((exp) => {
                const rawJson = (exp as unknown as { languages_json?: string }).languages_json;
                let parsedLangs = ['fr'];
                if (Array.isArray(exp.languages) && exp.languages.length > 0) {
                  parsedLangs = exp.languages;
                } else if (typeof rawJson === 'string') {
                  try {
                    parsedLangs = JSON.parse(rawJson);
                  } catch {
                    parsedLangs = ['fr'];
                  }
                }
                return (
                  <ExpertCard
                    key={exp.id}
                    expert={{ ...exp, languages: parsedLangs, tools: exp.tools || [], services: exp.services || [] }}
                    onRemoveFavorite={handleRemoveFavorite}
                  />
                );
              })}
            </div>
          ))}

        {/* FIDÉLITÉ */}
        {activeTab === 'rewards' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-2">
                <div className="text-xs uppercase text-[#C7A66A]">Solde Disponible</div>
                <div className="font-mono text-3xl font-semibold text-[#101323] tabular-nums">
                  {loyalty?.points_balance || 0} pts
                </div>
                <div className="text-xs text-[#64667A]">
                  Niveau : {TIER_FR[loyalty?.tier?.toLowerCase() || 'silver'] || 'ARGENT'}
                </div>
                <Button size="sm" onClick={handleDailyClaim} className="mt-2">
                  Réclamer Bonus +25 Points
                </Button>
              </div>

              <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-2 md:col-span-2">
                <div className="text-xs uppercase text-[#C7A66A]">Programme de Parrainage</div>
                <div className="font-serif text-2xl text-[#101323]">Invitez vos proches, recevez 200 Points Astraux</div>
                <p className="text-sm text-[#64667A]">
                  Partagez votre code personnel <span className="font-mono font-semibold text-[#101323]">{loyalty?.referral_code}</span> lors de leur inscription.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
                <h3 className="font-serif text-2xl text-[#101323]">Bons de Réduction Disponibles</h3>
                {((rewardsData?.redeemableCoupons as Array<Record<string, unknown>>) || []).map((c) => (
                  <div key={String(c.id)} className="flex items-center justify-between border border-[#25263A]/10 rounded-md p-4">
                    <div>
                      <div className="font-mono font-semibold text-[#101323]">{String(c.code)}</div>
                      <div className="text-xs text-[#64667A]">
                        Valeur : {formatCurrency(Number(c.discount_value))} · Coût : {String(c.points_cost)} pts
                      </div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => handleRedeemCoupon(String(c.id))}>
                      Échanger
                    </Button>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
                <h3 className="font-serif text-2xl text-[#101323]">Historique des Points</h3>
                <div className="divide-y divide-[#25263A]/10 max-h-[300px] overflow-y-auto">
                  {((rewardsData?.transactions as Array<Record<string, unknown>>) || []).map((t) => (
                    <div key={String(t.id)} className="py-2.5 flex items-center justify-between text-sm">
                      <div>
                        <div className="text-[#101323]">{String(t.description)}</div>
                        <div className="text-xs text-[#64667A]">{formatDate(String(t.created_at))}</div>
                      </div>
                      <span className="font-mono tabular-nums font-medium text-[#101323]">
                        {Number(t.points_delta) > 0 ? '+' : ''}
                        {String(t.points_delta)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* NOTIFICATIONS */}
        {activeTab === 'notifications' && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-2xl text-[#101323]">Notifications</h2>
              <Button
                size="sm"
                variant="outline"
                disabled={unreadNotificationCount === 0}
                onClick={async () => {
                  try {
                    await apiFetch('/api/client/notifications/read-all', { method: 'POST' });
                    setNotifications((current) => current.map((notification) => ({ ...notification, is_read: 1 })));
                  } catch (err) {
                    setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de marquer les notifications comme lues' });
                  }
                }}
              >
                Tout marquer comme lu
              </Button>
            </div>
            <div className="divide-y divide-[#25263A]/10">
              {notifications.length === 0 ? (
                <p className="py-4 text-sm text-[#64667A]">Vous n’avez aucune notification pour le moment.</p>
              ) : notifications.map((n) => (
                <div key={String(n.id)} className="py-3.5 flex items-start justify-between gap-4">
                  <div>
                    <div className="font-medium text-sm text-[#101323]">{String(n.title)}</div>
                    <div className="text-xs text-[#64667A] mt-0.5">{String(n.body)}</div>
                  </div>
                  <span className="text-xs text-[#64667A] shrink-0">{n.is_read ? 'Lue' : 'Non lue'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ASSISTANCE */}
        {activeTab === 'support' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <form
              onSubmit={handleSupportTicketSubmit}
              className="lg:col-span-5 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4"
            >
              <h2 className="font-serif text-2xl text-[#101323]">Ouvrir un Ticket d’Assistance</h2>
              <Select label="Catégorie" value={ticketCategory} onChange={(e) => setTicketCategory(e.target.value)}>
                <option value="billing">Facturation &amp; Remboursements</option>
                <option value="consultation">Suivi de Consultation</option>
                <option value="account">Compte &amp; Confidentialité</option>
              </Select>
              <Input
                label="Objet"
                required
                minLength={4}
                maxLength={160}
                value={ticketSubject}
                onChange={(e) => setTicketSubject(e.target.value)}
              />
              <Textarea
                label="Message"
                rows={4}
                required
                minLength={10}
                maxLength={3000}
                value={ticketMsg}
                onChange={(e) => setTicketMsg(e.target.value)}
              />
              <p className="-mt-2 text-xs text-[#64667A]">Objet : 4 à 160 caractères. Message : 10 à 3 000 caractères.</p>
              <Button
                type="submit"
                disabled={
                  submittingSupportTicket
                  || ticketSubject.trim().length < 4
                  || ticketSubject.trim().length > 160
                  || ticketMsg.trim().length < 10
                  || ticketMsg.trim().length > 3000
                }
              >
                {submittingSupportTicket ? 'Envoi en cours...' : 'Envoyer le Ticket'}
              </Button>
            </form>

            <div className="lg:col-span-7">
              <ClientSupportMessenger
                key={supportRefreshKey}
                onRead={() => {
                  void refreshUnreadMessages();
                  void refreshUnreadSupport();
                }}
              />
            </div>
          </div>
        )}

        {/* PROFIL & RGPD */}
        {activeTab === 'settings' && (
          <form onSubmit={handleSaveProfile} className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
            <h2 className="font-serif text-2xl text-[#101323]">Profil &amp; Préférences</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Prénom" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              <Input label="Nom" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
            <Input label="Numéro de Téléphone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
              <Button type="submit">Enregistrer les Préférences</Button>
              <Button
                type="button"
                variant="danger"
                onClick={async () => {
                  await apiFetch('/api/auth/deactivate', { method: 'POST' });
                  await logout();
                  navigate('/');
                }}
              >
                Désactiver mon Compte
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Fenêtre de publication d'avis */}
      <Modal open={Boolean(reviewConsultId)} onClose={() => setReviewConsultId(null)} title="Publier un Avis Vérifié">
        <form onSubmit={handleSubmitReview} className="space-y-4">
          <Select label="Note" value={reviewRating} onChange={(e) => setReviewRating(Number(e.target.value))}>
            <option value={5}>5 — Clarté Exceptionnelle</option>
            <option value={4}>4 — Très Utile</option>
            <option value={3}>3 — Satisfaisant</option>
            <option value={2}>2 — En deçà des attentes</option>
            <option value={1}>1 — Expérience insuffisante</option>
          </Select>
          <Textarea
            label="Votre Avis Écrit (min. 10 caractères)"
            rows={4}
            required
            value={reviewComment}
            onChange={(e) => setReviewComment(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setReviewConsultId(null)}>
              Annuler
            </Button>
            <Button type="submit">Publier l’Avis</Button>
          </div>
        </form>
      </Modal>
    </DashboardShell>
  );
}
