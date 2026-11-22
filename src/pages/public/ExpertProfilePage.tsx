import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Star, Heart, MessageSquare, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../lib/api';
import type { ExpertProfile } from '../../types';
import { AlertBanner, SafeImage } from '../../components/ui/Primitives';
import { CallExpertPhoneButton, Phone3DIcon } from '../../components/ui/Phone3DIcon';
import { CallTicketModal } from '../../components/ui/CallTicketModal';

export function ExpertProfilePage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [expert, setExpert] = useState<ExpertProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [favorited, setFavorited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [callTicketOpen, setCallTicketOpen] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    apiFetch<{ expert: ExpertProfile }>(`/api/public/experts/${slug}`)
      .then((d) => {
        setExpert(d.expert);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Impossible de charger le profil du conseiller'))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    if (!user || !expert) return;
    apiFetch<{ favorites: Array<{ id: string }> }>('/api/client/favorites')
      .then((d) => setFavorited(d.favorites.some((f) => f.id === expert.id)))
      .catch(() => {});
  }, [user, expert?.id]);

  const toggleFavorite = async () => {
    if (!user) {
      navigate('/login');
      return;
    }
    if (!expert) return;
    const res = await apiFetch<{ favorited: boolean }>(`/api/client/favorites/${expert.id}`, { method: 'POST' });
    setFavorited(res.favorited);
  };

  if (loading) {
    return <div className="w-full px-6 lg:px-12 xl:px-16 py-16 text-sm text-[#64667A]">Chargement du profil du conseiller...</div>;
  }

  if (error || !expert) {
    return (
      <div className="w-full px-6 lg:px-12 xl:px-16 py-16">
        <AlertBanner tone="error">{error || 'Profil de conseiller introuvable'}</AlertBanner>
      </div>
    );
  }

  const biography = expert.biography.trim();
  const languageLabels: Record<string, string> = { fr: 'Français', en: 'Anglais', ar: 'Arabe' };

  return (
    <div className="w-full bg-[#F7F4EF] min-h-screen pb-20">
      {/* En-tête éditorial pleine largeur */}
      <section className="w-full bg-[#101323] text-[#F7F4EF] py-14">
        <div className="w-full px-6 lg:px-12 xl:px-16 grid grid-cols-1 gap-8 lg:grid-cols-12 items-center">
          <div className="lg:col-span-4">
            <div className="aspect-[3/4] max-w-[320px] overflow-hidden rounded-lg border border-white/10 bg-[#191E32]">
              <SafeImage
                src={expert.avatar_url}
                alt={expert.display_name}
                fallbackTitle={expert.display_name}
                className="h-full w-full object-cover object-top"
              />
            </div>
          </div>

          <div className="lg:col-span-8 space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#C7A66A]">
              <span>{expert.specialty}</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5" />
                {expert.is_verified ? 'Conseiller Vérifié' : 'Vérification en cours'}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {expert.presence_status === 'online'
                  ? 'Disponible en direct'
                  : expert.presence_status === 'busy'
                  ? 'En séance'
                  : 'Sur rendez-vous'}
              </span>
              {expert.is_demo === 1 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Profil Démo</span>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <h1 className="font-serif text-4xl sm:text-5xl font-medium text-[#F7F4EF]">{expert.display_name}</h1>
              <CallExpertPhoneButton
                expertName={expert.display_name}
                size={44}
                onClick={() => setCallTicketOpen(true)}
              />
            </div>

            <p className="text-lg text-[#F7F4EF]/80 max-w-3xl">{expert.headline}</p>

            <div className="grid grid-cols-3 gap-6 border-y border-white/10 py-4 max-w-lg">
              <div>
                <div className="flex items-center gap-1 font-mono text-xl font-medium tabular-nums text-[#C7A66A]">
                  <Star className="h-4 w-4 fill-[#C7A66A]" />
                  {(expert.rating_avg_bp / 100).toFixed(2)}
                </div>
                <div className="text-xs text-[#F7F4EF]/65">
                  {expert.review_count}{' '}
                  {expert.rating_override_bp != null || expert.review_count_override != null ? 'avis affichés' : 'avis vérifiés'}
                </div>
              </div>
              <div>
                <div className="font-mono text-xl font-medium tabular-nums">{expert.completed_consultations}</div>
                <div className="text-xs text-[#F7F4EF]/65">Consultations</div>
              </div>
              <div>
                <div className="font-mono text-xl font-medium tabular-nums">{expert.years_experience} ans</div>
                <div className="text-xs text-[#F7F4EF]/65">D’expérience</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              {expert.external_chat_url && (
                <a
                  href={expert.external_chat_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[#C7A66A] px-5 py-2.5 text-sm font-medium text-[#101323] transition-colors duration-150 hover:bg-[#B49154] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C7A66A]"
                >
                  <MessageSquare className="h-4 w-4" />
                  Démarrer un Tchat en Direct
                </a>
              )}
              <button
                type="button"
                onClick={() => setCallTicketOpen(true)}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-md border border-[#16A34A]/60 bg-[#16A34A]/15 px-4 py-2 text-sm font-medium text-[#DCFCE7] hover:bg-[#16A34A]/25"
              >
                <Phone3DIcon size={26} />
                Appel direct
              </button>
              <button
                type="button"
                onClick={toggleFavorite}
                className="inline-flex items-center gap-2 rounded-md border border-white/20 px-4 py-2.5 text-xs font-medium text-[#F7F4EF] hover:bg-white/10"
              >
                <Heart className={`h-4 w-4 ${favorited ? 'fill-[#C7A66A] text-[#C7A66A]' : ''}`} />
                {favorited ? 'Enregistré' : 'Ajouter aux Favoris'}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="w-full bg-white py-14">
        <div className="w-full px-6 lg:px-12 xl:px-16 grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#A78447]">Présentation</p>
            <h2 className="mt-2 font-serif text-3xl font-medium text-[#101323]">À propos de {expert.display_name}</h2>
            <p className="mt-5 max-w-3xl whitespace-pre-line text-base leading-8 text-[#4B4D60]">
              {biography || 'La biographie de ce conseiller sera bientôt disponible.'}
            </p>
          </div>

          <div className="space-y-8 lg:col-span-5">
            <div>
              <h3 className="font-serif text-xl font-medium text-[#101323]">Domaines d’expertise</h3>
              <p className="mt-2 text-[#4B4D60]">{expert.specialty}</p>
            </div>

            {expert.tools.length > 0 && (
              <div>
                <h3 className="font-serif text-xl font-medium text-[#101323]">Pratiques & outils</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {expert.tools.map((tool) => (
                    <span key={tool} className="rounded-full border border-[#E8E3DA] bg-[#FAF9F6] px-3 py-1.5 text-sm text-[#4B4D60]">
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {expert.languages.length > 0 && (
              <div>
                <h3 className="font-serif text-xl font-medium text-[#101323]">Langues de consultation</h3>
                <p className="mt-2 text-[#4B4D60]">
                  {expert.languages.map((language) => languageLabels[language.toLowerCase()] || language).join(' · ')}
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      <CallTicketModal
        expert={callTicketOpen ? { id: expert.id, display_name: expert.display_name, specialty: expert.specialty } : null}
        onClose={() => setCallTicketOpen(false)}
      />
    </div>
  );
}
