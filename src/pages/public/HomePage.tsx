import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';
import type { ExpertProfile } from '../../types';
import { ExpertCard } from '../../components/experts/ExpertCard';
import { RecommendationWizard } from '../../components/experts/RecommendationWizard';
import { Phone3DIcon } from '../../components/ui/Phone3DIcon';
import { CallTicketModal, type CallTicketExpertInfo } from '../../components/ui/CallTicketModal';
import heroImage from '../../assets/images/homepage-tarot-hero.jpg';

const MARQUEE_PHRASES = [
  'Un véritable savoir-faire',
  'Les experts de la voyance à votre service',
  'Votre avenir mérite les meilleurs médiums',
  'L’excellence de la voyance depuis des années',
  'Des voyants sélectionnés pour leur talent',
  'Une équipe de médiums à votre écoute',
  'Votre satisfaction, notre priorité absolue',
  'La référence incontournable de la voyance',
  'Un accompagnement personnalisé en toute confiance',
  'Des consultations de voyance de qualité',
  'Votre destin entre les mains de nos experts',
];

export function HomePage() {
  const { t, mainNumber } = useI18n();
  const [experts, setExperts] = useState<ExpertProfile[]>([]);
  const [stats, setStats] = useState<{
    verifiedExperts: number;
    completedConsultations: number;
    publishedReviews: number;
    includesDemoData: boolean;
  } | null>(null);
  const [ticketExpert, setTicketExpert] = useState<CallTicketExpertInfo | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ items: ExpertProfile[] }>('/api/public/experts?limit=8'),
      apiFetch<{
        verifiedExperts: number;
        completedConsultations: number;
        publishedReviews: number;
        includesDemoData: boolean;
      }>('/api/public/stats'),
    ])
      .then(([expData, statsData]) => {
        setExperts(expData.items);
        setStats(statsData);
      })
      .catch(() => {});
  }, []);

  const featuredExpert = experts.filter((e) => e.is_featured === 1)[0] || experts[0];
  const chatExperts = experts
    .filter((e) => e.presence_status === 'online' || e.services?.some((s) => s.service_type.startsWith('chat_')))
    .slice(0, 8);

  return (
    <div className="w-full bg-[#F7F4EF] text-[#25263A]">
      {/* Section Héro pleine largeur */}
      <section className="relative isolate w-full overflow-hidden bg-[#101323] text-[#F7F4EF]">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <img
            src={heroImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover"
            style={{ transform: 'scale(1.2)' }}
          />
        </div>
        <div className="absolute inset-0 bg-[#101323]/50" aria-hidden="true" />
        <div className="hero-particles" aria-hidden="true">
          {Array.from({ length: 20 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <div className="relative z-10 w-full px-6 py-16 lg:px-12 lg:py-24 xl:px-16">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 items-stretch">
            <div className="lg:col-span-6 flex flex-col justify-center space-y-6">
              <div className="text-xs font-medium tracking-[0.2em] uppercase text-[#C7A66A]">
                {t('hero_kicker')}
              </div>
              <h1 className="font-serif text-4xl sm:text-5xl lg:text-[58px] font-medium leading-[1.08] tracking-tight text-[#F7F4EF]">
                {t('hero_title')}
              </h1>
              <p className="max-w-2xl text-base leading-relaxed text-[#F7F4EF]/80">
                {t('hero_subtitle')}
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Link
                  to="/experts"
                  className="inline-flex items-center gap-2 rounded-md bg-[#C7A66A] px-6 py-3 text-sm font-semibold text-[#101323] transition-colors hover:bg-[#B49154] whitespace-nowrap shrink-0"
                >
                  {t('hero_primary_cta')}
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/tarot"
                  className="inline-flex items-center gap-2 rounded-md border border-white/20 px-6 py-3 text-sm font-medium text-[#F7F4EF] transition-colors hover:bg-white/10 whitespace-nowrap shrink-0"
                >
                  {t('hero_secondary_cta')}
                </Link>
              </div>
            </div>
          </div>

          {/* Bandeau de chiffres clés */}
          {stats && (
            <div
              className="relative mt-8 grid grid-cols-2 gap-6 border-t border-white/10 pt-8 md:grid-cols-4 md:translate-x-4 md:translate-y-[79px]"
            >
              <div>
                <div className="font-mono text-xl font-medium text-[#C7A66A] tabular-nums md:text-2xl">{stats.verifiedExperts}</div>
                <div className="mt-1 text-xs text-[#F7F4EF]/70">
                  Conseillers Vérifiés {stats.includesDemoData ? '· Profils de démonstration inclus' : ''}
                </div>
              </div>
              <div>
                <div className="font-mono text-xl font-medium text-[#F7F4EF] tabular-nums md:text-2xl">{stats.completedConsultations}</div>
                <div className="mt-1 text-xs text-[#F7F4EF]/70">Séances Enregistrées</div>
              </div>
              <div>
                <div className="font-mono text-xl font-medium text-[#F7F4EF] tabular-nums md:text-2xl">{stats.publishedReviews}</div>
                <div className="mt-1 text-xs text-[#F7F4EF]/70">Avis Vérifiés Après Séance</div>
              </div>
              <div>
                <div className="whitespace-nowrap font-mono text-xl font-medium text-[#C7A66A] tabular-nums md:text-2xl">{mainNumber}</div>
                <div className="mt-1 text-xs text-[#F7F4EF]/70">Numéro Principal</div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Bandeau défilant horizontal continu */}
      <div
        className="marquee-band w-full overflow-hidden border-y border-[#C7A66A]/30 bg-[#191E32] py-3.5 text-[#F7F4EF]"
        aria-label="Engagements Au-delà des Étoiles"
      >
        <div className="marquee-track">
          {[0, 1].map((dupIdx) => (
            <div
              key={dupIdx}
              className="flex shrink-0 items-center"
              aria-hidden={dupIdx === 1}
            >
              {MARQUEE_PHRASES.map((phrase, idx) => (
                <div key={`${dupIdx}-${idx}`} className="flex items-center">
                  <span className="px-6 font-serif text-base sm:text-lg tracking-wide text-[#F7F4EF]/95 whitespace-nowrap">
                    {phrase}
                  </span>
                  <span className="text-xs text-[#C7A66A]" aria-hidden="true">
                    ✦
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Conseillers disponibles en tchat direct */}
      <section className="w-full px-6 py-16 lg:px-12 xl:px-16">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
          <div>
            <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Messagerie &amp; Appel Direct</div>
            <h2 className="mt-1 font-serif text-3xl sm:text-4xl font-medium text-[#101323]">
              {t('section_online_chat')}
            </h2>
          </div>
          <Link to="/experts/chat" className="text-sm font-medium text-[#101323] hover:underline underline-offset-4">
            Voir tous les conseillers en direct →
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {chatExperts.map((exp) => (
            <ExpertCard key={exp.id} expert={exp} />
          ))}
        </div>
      </section>

      {/* Assistant d'orientation */}
      <section className="w-full px-6 py-16 lg:px-12 xl:px-16">
        <RecommendationWizard />
      </section>

      {/* Ligne Directe */}
      <section className="w-full border-y border-[#25263A]/10 bg-[#191E32] text-[#F7F4EF]">
        <div className="w-full px-6 py-16 lg:px-12 xl:px-16">
          <div className="space-y-4">
            <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">
              {t('section_voice')}
            </div>
            <h3 className="font-serif text-3xl font-medium">Ligne Directe &amp; Tickets d’Appel</h3>
            <p className="text-sm leading-relaxed text-[#F7F4EF]/80">
              Chaque conseiller dispose d’une icône téléphone verte permettant d’ouvrir instantanément un ticket d’appel avec notre numéro central, quel que soit son statut{' '}
              <span className="font-mono font-semibold text-[#C7A66A]">{mainNumber}</span> (Main Number), géré centralement par l’administration.
            </p>
            <div className="pt-2 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() =>
                  setTicketExpert(
                    featuredExpert
                      ? {
                          id: featuredExpert.id,
                          display_name: featuredExpert.display_name,
                          specialty: featuredExpert.specialty,
                        }
                      : { id: 'main-line', display_name: 'Au-delà des Étoiles' }
                  )
                }
                className="inline-flex items-center gap-2.5 rounded-md bg-[#C7A66A] px-5 py-2.5 text-xs font-semibold text-[#101323] hover:bg-[#B49154]"
              >
                <Phone3DIcon size={20} />
                Contacter un Conseiller
              </button>
            </div>
          </div>
        </div>
      </section>

      <CallTicketModal expert={ticketExpert} onClose={() => setTicketExpert(null)} />
    </div>
  );
}
