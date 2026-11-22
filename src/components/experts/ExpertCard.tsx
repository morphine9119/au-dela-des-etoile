import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Heart, Star } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';
import type { ExpertProfile } from '../../types';
import { SafeImage } from '../ui/Primitives';
import { CallExpertPhoneButton } from '../ui/Phone3DIcon';
import { CallTicketModal } from '../ui/CallTicketModal';

export function ExpertCard({
  expert,
  onRemoveFavorite,
}: {
  expert: ExpertProfile;
  onRemoveFavorite?: (expert: ExpertProfile) => void | Promise<void>;
}) {
  const { formatCurrency, freeOfferEnabled } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [callTicketOpen, setCallTicketOpen] = useState(false);
  const [removingFavorite, setRemovingFavorite] = useState(false);
  const [isFavorite, setIsFavorite] = useState(Boolean(onRemoveFavorite));
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    if (!user || onRemoveFavorite) {
      setIsFavorite(Boolean(onRemoveFavorite));
      return () => {
        active = false;
      };
    }
    apiFetch<{ favorites: Array<{ id: string }> }>('/api/client/favorites')
      .then(({ favorites }) => {
        if (active) setIsFavorite(favorites.some((favorite) => favorite.id === expert.id));
      })
      .catch(() => {
        if (active) setFavoriteError('Impossible de charger le statut favori.');
      });
    return () => {
      active = false;
    };
  }, [expert.id, onRemoveFavorite, user]);

  const handleToggleFavorite = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setFavoriteError(null);
    if (!user) {
      navigate('/login');
      return;
    }

    setRemovingFavorite(true);
    try {
      if (isFavorite && onRemoveFavorite) {
        await onRemoveFavorite(expert);
        setIsFavorite(false);
      } else {
        const result = await apiFetch<{ favorited: boolean }>(`/api/client/favorites/${expert.id}`, {
          method: 'POST',
        });
        setIsFavorite(result.favorited);
      }
    } catch (error) {
      setFavoriteError(error instanceof Error ? error.message : 'Impossible de modifier vos favoris.');
    } finally {
      setRemovingFavorite(false);
    }
  };

  const rating = (expert.rating_avg_bp / 100).toFixed(2);

  const availabilityLabel =
    expert.presence_status === 'online'
      ? 'En ligne'
      : expert.presence_status === 'busy'
      ? 'En séance'
      : 'Sur RDV';

  const availabilityDot =
    expert.presence_status === 'online'
      ? 'bg-[#4ADE80]'
      : expert.presence_status === 'busy'
      ? 'bg-[#FBBF24]'
      : 'bg-white/50';

  const originalPriceCents = expert.min_price_cents && expert.min_price_cents > 0 ? expert.min_price_cents : 390;

  return (
    <>
      <article className="group relative aspect-[4/5] w-full overflow-hidden rounded-lg border border-[#25263A]/10 bg-[#191E32] shadow-sm transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-lg">
        {/* Image portrait plein cadre */}
        <Link to={`/experts/${expert.slug}`} className="absolute inset-0 block h-full w-full">
          <SafeImage
            src={expert.avatar_url}
            alt={expert.display_name}
            fallbackTitle={expert.display_name}
            className="h-full w-full object-cover object-top brightness-110 transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#101323]/95 via-[#101323]/25 to-transparent" />
        </Link>

        {/* Barre supérieure discrète */}
        <div className="pointer-events-none relative z-10 flex items-center justify-between gap-2 p-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#101323]/70 px-2 py-1 text-[10px] font-medium text-[#F7F4EF] backdrop-blur-xs">
            <span className={`h-1.5 w-1.5 rounded-full ${availabilityDot}`} />
            {availabilityLabel}
          </span>
          <button
            type="button"
            aria-label={isFavorite ? `Retirer ${expert.display_name} des favoris` : `Ajouter ${expert.display_name} aux favoris`}
            title={
              favoriteError ||
              (isFavorite ? 'Retirer des favoris' : user ? 'Ajouter aux favoris' : 'Connectez-vous pour ajouter aux favoris')
            }
            disabled={removingFavorite}
            onClick={handleToggleFavorite}
            className={`pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#101323]/75 backdrop-blur-xs transition-colors hover:bg-[#101323] disabled:opacity-50 ${
              isFavorite ? 'text-[#C7A66A]' : 'text-white'
            }`}
          >
            <Heart className={`h-4 w-4 ${isFavorite ? 'fill-current' : ''}`} />
          </button>
        </div>

        {/* Informations essentielles superposées sur l'image */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-3.5 space-y-2.5">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-[#C7A66A] truncate">
              {expert.specialty}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <Link
                to={`/experts/${expert.slug}`}
                className="pointer-events-auto min-w-0 truncate font-serif text-xl font-medium leading-tight text-[#F7F4EF] hover:underline underline-offset-4"
              >
                {expert.display_name}
              </Link>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#101323]/70 px-1.5 py-0.5 text-[10px] font-medium text-[#F7F4EF] tabular-nums backdrop-blur-xs">
                <Star className="h-3 w-3 fill-[#C7A66A] text-[#C7A66A]" />
                {rating}
              </span>
            </div>
          </div>

          <div className="flex items-end justify-between gap-2 border-t border-white/15 pt-2.5">
            {freeOfferEnabled ? (
              <div className="flex flex-col items-start">
                <span className="font-mono text-[10px] text-[#F7F4EF]/75 tabular-nums">
                  À partir de <span className="line-through">{formatCurrency(originalPriceCents)}</span>
                </span>
                <span className="mt-0.5 font-mono text-[10px] text-[#4ADE80] tabular-nums">
                  {formatCurrency(0)}
                </span>
              </div>
            ) : (
              <span className="font-mono text-[10px] text-[#F7F4EF] tabular-nums">
                {expert.min_price_cents ? `À partir de ${formatCurrency(expert.min_price_cents)}` : 'Sur demande'}
              </span>
            )}

            <div className="pointer-events-auto flex items-center gap-1.5 shrink-0">
              <CallExpertPhoneButton
                expertName={expert.display_name}
                size={28}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCallTicketOpen(true);
                }}
              />
              {expert.external_chat_url ? (
                <a
                  href={expert.external_chat_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md bg-[#C7A66A] px-2.5 py-1.5 text-[10px] font-semibold text-[#101323] hover:bg-[#B49154] whitespace-nowrap"
                >
                  Consulter
                </a>
              ) : (
                <button
                  type="button"
                  disabled
                  title="Lien externe non configuré par l’administrateur"
                  aria-label={`Lien externe non configuré pour ${expert.display_name}`}
                  className="cursor-not-allowed rounded-md bg-[#C7A66A] px-2.5 py-1.5 text-[10px] font-semibold text-[#101323] opacity-50 whitespace-nowrap"
                >
                  Consulter
                </button>
              )}
            </div>
          </div>
        </div>
      </article>

      <CallTicketModal
        expert={callTicketOpen ? { id: expert.id, display_name: expert.display_name, specialty: expert.specialty } : null}
        onClose={() => setCallTicketOpen(false)}
      />
    </>
  );
}
