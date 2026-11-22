import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Calendar,
  UserCheck,
  Briefcase,
  DollarSign,
  Star,
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';
import { ChatWorkspace } from '../../components/chat/ChatWorkspace';
import { DashboardShell, type NavItem } from '../../components/layout/DashboardShell';
import { AlertBanner, Button, Input, Select, Textarea } from '../../components/ui/Primitives';

const ROUTE_TO_TAB: Record<string, string> = {
  '/expert/dashboard': 'overview',
  '/expert/messages': 'messages',
  '/expert/consultations': 'consultations',
  '/expert/availability': 'availability',
  '/expert/services': 'services',
  '/expert/profile': 'profile',
  '/expert/earnings': 'earnings',
  '/expert/transactions': 'earnings',
  '/expert/reviews': 'reviews',
};

const PRESENCE_LABELS: Record<'online' | 'busy' | 'offline', string> = {
  online: 'En ligne (Tchat Direct)',
  busy: 'En séance',
  offline: 'Hors ligne',
};

const SERVICE_TYPE_LABELS: Record<string, string> = {
  chat_per_message: 'Tchat (Par message)',
  chat_per_minute: 'Tchat (À la minute)',
  chat_fixed: 'Lecture Écrite (Forfait)',
  scheduled_appointment: 'Rendez-vous Planifié',
  phone_per_minute: 'Appel Téléphonique',
};

const STATUS_FR: Record<string, string> = {
  active: 'En cours',
  pending: 'En attente',
  completed: 'Terminée',
  confirmed: 'Confirmée',
  cancelled: 'Annulée',
};

export function ExpertDashboard() {
  const { formatCurrency, formatDate, freeOfferEnabled } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  const activeTab = ROUTE_TO_TAB[location.pathname] || 'overview';
  const setTab = (id: string) => {
    navigate(id === 'overview' ? '/expert/dashboard' : `/expert/${id}`);
  };

  const [dash, setDash] = useState<Record<string, unknown> | null>(null);
  const [consultations, setConsultations] = useState<Array<Record<string, unknown>>>([]);
  const [earningsData, setEarningsData] = useState<{ earnings: Array<Record<string, unknown>>; withdrawals: Array<Record<string, unknown>> }>({
    earnings: [],
    withdrawals: [],
  });
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  // Profil
  const [displayName, setDisplayName] = useState('');
  const [headline, setHeadline] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [biography, setBiography] = useState('');

  // Nouveau Service
  const [svcType, setSvcType] = useState('chat_per_minute');
  const [svcTitle, setSvcTitle] = useState('');
  const [svcPriceEur, setSvcPriceEur] = useState('3.50');

  // Planning
  const [availRows, setAvailRows] = useState<Array<{ dayOfWeek: number; startTime: string; endTime: string; isBreak: boolean }>>([]);

  // Retrait
  const [withdrawEur, setWithdrawEur] = useState('20.00');
  const [payoutMethod, setPayoutMethod] = useState('Virement SEPA IBAN');

  // Réponse aux avis
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});

  const loadData = async () => {
    try {
      const [d, c, e] = await Promise.all([
        apiFetch<Record<string, unknown>>('/api/expert/dashboard'),
        apiFetch<{ consultations: Array<Record<string, unknown>> }>('/api/expert/consultations'),
        apiFetch<{ earnings: Array<Record<string, unknown>>; withdrawals: Array<Record<string, unknown>> }>('/api/expert/earnings'),
      ]);
      setDash(d);
      setConsultations(c.consultations);
      setEarningsData(e);

      const exp = d.expert as Record<string, unknown>;
      setDisplayName(String(exp.display_name || ''));
      setHeadline(String(exp.headline || ''));
      setSpecialty(String(exp.specialty || ''));
      setBiography(String(exp.biography || ''));

      const av = (d.availability as Array<{ day_of_week: number; start_time: string; end_time: string; is_break: number }>) || [];
      setAvailRows(av.map((r) => ({ dayOfWeek: r.day_of_week, startTime: r.start_time, endTime: r.end_time, isBreak: Boolean(r.is_break) })));
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de charger l’espace conseiller' });
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const expert = dash?.expert as Record<string, unknown> | undefined;
  const summary = dash?.earningsSummary as { available_cents: number; pending_cents: number; total_net_cents: number } | undefined;
  const withdrawnTotal = Number(dash?.withdrawnTotal || 0);
  const withdrawableCents = Math.max(0, (summary?.available_cents || 0) - withdrawnTotal);

  const navItems: NavItem[] = [
    { id: 'overview', label: 'Vue d’ensemble', icon: <LayoutDashboard className="h-4 w-4" /> },
    { id: 'messages', label: 'Messages en Direct', icon: <MessageSquare className="h-4 w-4" /> },
    { id: 'consultations', label: 'Consultations', icon: <Briefcase className="h-4 w-4" /> },
    { id: 'availability', label: 'Planning', icon: <Calendar className="h-4 w-4" /> },
    { id: 'services', label: 'Services & Tarifs', icon: <UserCheck className="h-4 w-4" /> },
    { id: 'earnings', label: 'Revenus & Virements', icon: <DollarSign className="h-4 w-4" /> },
    { id: 'reviews', label: 'Avis Clients', icon: <Star className="h-4 w-4" /> },
    { id: 'profile', label: 'Profil Public', icon: <UserCheck className="h-4 w-4" /> },
  ];

  const handlePresenceChange = async (presenceStatus: 'online' | 'busy' | 'offline') => {
    await apiFetch('/api/expert/presence', { method: 'POST', body: JSON.stringify({ presenceStatus }) });
    loadData();
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    try {
      await apiFetch('/api/expert/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName,
          headline,
          specialty,
          biography,
          languages: JSON.parse(String(expert?.languages_json || '["fr"]')),
          tools: JSON.parse(String(expert?.tools_json || '[]')),
        }),
      });
      setBanner({ tone: 'success', text: 'Profil conseiller mis à jour.' });
      loadData();
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Échec de la mise à jour' });
    }
  };

  const handleAddService = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const cents = Math.round(Number(svcPriceEur) * 100);
    try {
      await apiFetch('/api/expert/services', {
        method: 'POST',
        body: JSON.stringify({ serviceType: svcType, title: svcTitle, priceCents: cents, durationMinutes: svcType === 'scheduled_appointment' ? 45 : null }),
      });
      setSvcTitle('');
      setBanner({ tone: 'success', text: 'Tarif de service ajouté.' });
      loadData();
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’ajouter le service' });
    }
  };

  const handleWithdrawal = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const amountCents = Math.round(Number(withdrawEur) * 100);
    try {
      await apiFetch('/api/expert/withdrawals', {
        method: 'POST',
        body: JSON.stringify({ amountCents, payoutMethod }),
      });
      setBanner({ tone: 'success', text: 'Demande de retrait soumise pour validation administrative.' });
      loadData();
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Échec de la demande de retrait' });
    }
  };

  const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

  return (
    <DashboardShell
      portalTitle="Espace Conseiller"
      subtitle={expert ? String(expert.display_name) : undefined}
      navItems={navItems}
      activeTab={activeTab}
      onSelectTab={setTab}
      headerActions={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[#64667A]">Disponibilité :</span>
          {(['online', 'busy', 'offline'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => handlePresenceChange(st)}
              className={`rounded px-3 py-1.5 text-xs font-medium border ${
                expert?.presence_status === st
                  ? 'border-[#101323] bg-[#101323] text-white'
                  : 'border-[#25263A]/15 bg-white text-[#25263A]'
              }`}
            >
              {PRESENCE_LABELS[st]}
            </button>
          ))}
        </div>
      }
    >
      <div className="space-y-6 w-full">
        {banner && <AlertBanner tone={banner.tone}>{banner.text}</AlertBanner>}

        {activeTab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-[#25263A]/10 bg-white p-5">
                <div className="text-xs text-[#64667A]">Gains Nets Retirables</div>
                <div className="mt-1 font-mono text-2xl font-medium text-[#101323] tabular-nums">
                  {formatCurrency(withdrawableCents)}
                </div>
              </div>
              <div className="rounded-lg border border-[#25263A]/10 bg-white p-5">
                <div className="text-xs text-[#64667A]">Consultations du Mois</div>
                <div className="mt-1 font-mono text-2xl font-medium text-[#101323] tabular-nums">
                  {Number(dash?.monthlyConsultations || 0)}
                </div>
              </div>
              <div className="rounded-lg border border-[#25263A]/10 bg-white p-5">
                <div className="text-xs text-[#64667A]">Note Moyenne</div>
                <div className="mt-1 font-mono text-2xl font-medium text-[#101323] tabular-nums">
                  {((Number(expert?.rating_avg_bp || 0)) / 100).toFixed(2)} / 5.0
                </div>
              </div>
              <div className="rounded-lg border border-[#25263A]/10 bg-white p-5">
                <div className="text-xs text-[#64667A]">Rendez-vous à Venir</div>
                <div className="mt-1 font-mono text-2xl font-medium text-[#101323] tabular-nums">
                  {((dash?.upcomingAppointments as unknown[]) || []).length}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-3">
              <h2 className="font-serif text-2xl text-[#101323]">Séances Planifiées à Venir</h2>
              {((dash?.upcomingAppointments as Array<Record<string, unknown>>) || []).length === 0 ? (
                <p className="text-sm text-[#64667A]">Aucun rendez-vous planifié prochainement.</p>
              ) : (
                ((dash?.upcomingAppointments as Array<Record<string, unknown>>) || []).map((a) => (
                  <div key={String(a.id)} className="flex items-center justify-between border-t border-[#25263A]/10 pt-3 text-sm">
                    <div>
                      <div className="font-medium text-[#101323]">{String(a.client_name)} — {String(a.service_title)}</div>
                      <div className="text-xs text-[#64667A]">
                        {new Date(String(a.scheduled_start)).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}
                      </div>
                    </div>
                    <span className="font-mono text-xs tabular-nums">{formatCurrency(Number(a.price_cents))}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'messages' && <ChatWorkspace mode="expert" />}

        {activeTab === 'consultations' && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white overflow-x-auto">
            <div className="px-6 py-4 border-b border-[#25263A]/10">
              <h2 className="font-serif text-2xl text-[#101323]">Toutes les Consultations</h2>
            </div>
            <table className="w-full min-w-[760px] text-start text-sm">
              <thead className="whitespace-nowrap bg-[#F7F4EF]/60 border-b border-[#25263A]/10 text-xs text-[#64667A]">
                <tr>
                  <th className="px-6 py-3 text-start">Client</th>
                  <th className="px-6 py-3 text-start">Service</th>
                  <th className="px-6 py-3 text-start">Statut</th>
                  <th className="px-6 py-3 text-end">Montant Brut</th>
                  <th className="px-6 py-3 text-end">Gains Nets</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#25263A]/10">
                {consultations.map((c) => (
                  <tr key={String(c.id)}>
                    <td className="px-6 py-3.5 font-medium">{String(c.client_name)}</td>
                    <td className="px-6 py-3.5 text-[#64667A]">{String(c.service_title)}</td>
                    <td className="px-6 py-3.5 text-xs uppercase">{STATUS_FR[String(c.status)] || String(c.status)}</td>
                    <td className="px-6 py-3.5 text-end font-mono tabular-nums">{formatCurrency(Number(c.gross_amount_cents || 0))}</td>
                    <td className="px-6 py-3.5 text-end font-mono tabular-nums text-[#166534]">{formatCurrency(Number(c.expert_net_cents || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'availability' && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-serif text-2xl text-[#101323]">Planning Hebdomadaire &amp; Pauses</h2>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAvailRows([...availRows, { dayOfWeek: 1, startTime: '09:00', endTime: '12:00', isBreak: false }])}
                >
                  Ajouter un Créneau
                </Button>
                <Button
                  size="sm"
                  onClick={async () => {
                    await apiFetch('/api/expert/availability', { method: 'PUT', body: JSON.stringify({ slots: availRows }) });
                    setBanner({ tone: 'success', text: 'Planning hebdomadaire enregistré.' });
                  }}
                >
                  Enregistrer le Planning
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {availRows.map((row, idx) => (
                <div key={idx} className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-center border-b border-[#25263A]/10 pb-2">
                  <select
                    value={row.dayOfWeek}
                    onChange={(e) => {
                      const next = [...availRows];
                      next[idx].dayOfWeek = Number(e.target.value);
                      setAvailRows(next);
                    }}
                    className="rounded border border-[#25263A]/20 px-2 py-1.5 text-xs"
                  >
                    {days.map((d, i) => (
                      <option key={d} value={i}>{d}</option>
                    ))}
                  </select>
                  <input
                    type="time"
                    value={row.startTime}
                    onChange={(e) => {
                      const next = [...availRows];
                      next[idx].startTime = e.target.value;
                      setAvailRows(next);
                    }}
                    className="rounded border border-[#25263A]/20 px-2 py-1.5 text-xs font-mono"
                  />
                  <input
                    type="time"
                    value={row.endTime}
                    onChange={(e) => {
                      const next = [...availRows];
                      next[idx].endTime = e.target.value;
                      setAvailRows(next);
                    }}
                    className="rounded border border-[#25263A]/20 px-2 py-1.5 text-xs font-mono"
                  />
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={row.isBreak}
                      onChange={(e) => {
                        const next = [...availRows];
                        next[idx].isBreak = e.target.checked;
                        setAvailRows(next);
                      }}
                    />
                    Période de pause
                  </label>
                  <button
                    type="button"
                    onClick={() => setAvailRows(availRows.filter((_, i) => i !== idx))}
                    className="text-xs text-[#991B1B] hover:underline text-end"
                  >
                    Supprimer
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'services' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <form onSubmit={handleAddService} className="lg:col-span-5 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
              <h2 className="font-serif text-2xl text-[#101323]">Ajouter un Tarif de Consultation</h2>
              <Select label="Type de Service" value={svcType} onChange={(e) => setSvcType(e.target.value)}>
                <option value="chat_per_message">Tchat (Par Message)</option>
                <option value="chat_per_minute">Tchat (Par Minute)</option>
                <option value="chat_fixed">Étude Écrite (Forfait)</option>
                <option value="scheduled_appointment">Rendez-vous Planifié (45 min)</option>
              </Select>
              <Input label="Intitulé du Service" required value={svcTitle} onChange={(e) => setSvcTitle(e.target.value)} />
              <Input label="Tarif de Base (EUR)" type="number" step="0.10" required value={svcPriceEur} onChange={(e) => setSvcPriceEur(e.target.value)} />
              <Button type="submit">Ajouter le Service</Button>
            </form>

            <div className="lg:col-span-7 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-serif text-2xl text-[#101323]">Services Configurés</h2>
                {freeOfferEnabled && (
                  <span className="rounded border border-[#16A34A]/50 bg-[#F0FDF4] px-2.5 py-1 text-xs font-medium text-[#15803D] free-offer-glow">
                    Offre publique active : 0,00 € (tarif original conservé)
                  </span>
                )}
              </div>
              <div className="divide-y divide-[#25263A]/10">
                {((dash?.services as Array<Record<string, unknown>>) || []).map((s) => (
                  <div key={String(s.id)} className="py-3 flex items-center justify-between gap-4 text-sm">
                    <div>
                      <div className="font-medium text-[#101323]">{String(s.title)}</div>
                      <div className="text-xs text-[#64667A]">
                        {SERVICE_TYPE_LABELS[String(s.service_type)] || String(s.service_type)}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      {freeOfferEnabled ? (
                        <div className="flex flex-col items-end">
                          <span className="font-mono text-xs text-[#64667A] line-through tabular-nums">
                            {formatCurrency(Number(s.price_cents))}
                          </span>
                          <span className="mt-0.5 rounded border border-[#16A34A]/50 bg-[#F0FDF4] px-2 py-0.5 text-xs font-bold text-[#15803D] tabular-nums free-offer-glow">
                            {formatCurrency(0)}
                          </span>
                        </div>
                      ) : (
                        <span className="font-mono tabular-nums">{formatCurrency(Number(s.price_cents))}</span>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/expert/services/${s.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !s.is_active }) });
                          loadData();
                        }}
                        className="text-xs font-medium text-[#B49154] hover:underline"
                      >
                        {s.is_active ? 'Désactiver' : 'Activer'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'earnings' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <form onSubmit={handleWithdrawal} className="lg:col-span-5 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
              <h2 className="font-serif text-2xl text-[#101323]">Demander un Retrait</h2>
              <div className="text-xs text-[#64667A]">
                Solde retirable : <span className="font-mono font-semibold text-[#101323]">{formatCurrency(withdrawableCents)}</span>
              </div>
              <Input label="Montant (EUR)" type="number" step="0.50" required value={withdrawEur} onChange={(e) => setWithdrawEur(e.target.value)} />
              <Input label="Moyen de Versement" required value={payoutMethod} onChange={(e) => setPayoutMethod(e.target.value)} />
              <Button type="submit">Soumettre la Demande de Retrait</Button>
            </form>

            <div className="lg:col-span-7 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
              <h2 className="font-serif text-2xl text-[#101323]">Détail des Revenus &amp; Commissions</h2>
              <div className="divide-y divide-[#25263A]/10 text-sm">
                {earningsData.earnings.map((e) => (
                  <div key={String(e.id)} className="py-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium text-[#101323]">
                        {SERVICE_TYPE_LABELS[String(e.service_type)] || String(e.service_type)}
                      </div>
                      <div className="text-xs text-[#64667A]">{formatDate(String(e.created_at))}</div>
                    </div>
                    <div className="text-end font-mono tabular-nums text-xs">
                      <div>Brut : {formatCurrency(Number(e.gross_cents))} · Commission : -{formatCurrency(Number(e.commission_cents))}</div>
                      <div className="text-sm font-semibold text-[#166534]">Net : {formatCurrency(Number(e.net_cents))}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'reviews' && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
            <h2 className="font-serif text-2xl text-[#101323]">Avis des Clients</h2>
            {((dash?.recentReviews as Array<Record<string, unknown>>) || []).map((r) => (
              <div key={String(r.id)} className="border-t border-[#25263A]/10 pt-4 space-y-2">
                <div className="flex justify-between text-xs text-[#64667A]">
                  <span>{String(r.client_name || 'Client')}</span>
                  <span className="font-mono">{String(r.rating)}.0 / 5.0</span>
                </div>
                <p className="text-sm text-[#25263A]">{String(r.comment)}</p>
                {r.expert_reply ? (
                  <div className="text-xs bg-[#F7F4EF] p-3 rounded">Votre réponse : {String(r.expert_reply)}</div>
                ) : (
                  <div className="flex gap-2 pt-1">
                    <input
                      type="text"
                      placeholder="Rédiger une réponse posée et professionnelle..."
                      value={replyDrafts[String(r.id)] || ''}
                      onChange={(e) => setReplyDrafts({ ...replyDrafts, [String(r.id)]: e.target.value })}
                      className="flex-1 rounded border border-[#25263A]/20 px-3 py-1.5 text-xs"
                    />
                    <Button
                      size="sm"
                      onClick={async () => {
                        await apiFetch(`/api/expert/reviews/${r.id}/reply`, {
                          method: 'POST',
                          body: JSON.stringify({ reply: replyDrafts[String(r.id)] }),
                        });
                        loadData();
                      }}
                    >
                      Répondre
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'profile' && (
          <form onSubmit={handleSaveProfile} className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
            <h2 className="font-serif text-2xl text-[#101323]">Modifier le Profil Public de Conseiller</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Input label="Nom d’Affichage" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <Input label="Titre Éditorial" value={headline} onChange={(e) => setHeadline(e.target.value)} />
              <Input label="Spécialité Principale" value={specialty} onChange={(e) => setSpecialty(e.target.value)} />
            </div>
            <Textarea label="Biographie" rows={6} value={biography} onChange={(e) => setBiography(e.target.value)} />
            <Button type="submit">Enregistrer les Modifications</Button>
          </form>
        )}
      </div>
    </DashboardShell>
  );
}
