import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, RotateCcw } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import type { Category, ExpertProfile } from '../../types';
import { ExpertCard } from '../../components/experts/ExpertCard';
import { Button, EmptyState } from '../../components/ui/Primitives';

export function ExpertsPage({ defaultMethod = '' }: { defaultMethod?: string }) {
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') || '';
  const category = searchParams.get('category') || '';
  const method = searchParams.get('method') ?? defaultMethod;
  const language = searchParams.get('language') || '';
  const online = searchParams.get('online') === 'true';
  const minRating = searchParams.get('minRating') || '';
  const minExperience = searchParams.get('minExperience') || '';
  const maxPrice = searchParams.get('maxPrice') || '';
  const sort = searchParams.get('sort') || 'recommended';
  const page = Number(searchParams.get('page') || 1);

  const [searchDraft, setSearchDraft] = useState(q);
  const [categories, setCategories] = useState<Category[]>([]);
  const [experts, setExperts] = useState<ExpertProfile[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ categories: Category[] }>('/api/public/bootstrap')
      .then((d) => setCategories(d.categories))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (category) qs.set('category', category);
    if (method) qs.set('method', method);
    if (language) qs.set('language', language);
    if (online) qs.set('online', 'true');
    if (minRating) qs.set('minRating', minRating);
    if (minExperience) qs.set('minExperience', minExperience);
    if (maxPrice) qs.set('maxPriceCents', String(Number(maxPrice) * 100));
    qs.set('sort', sort);
    qs.set('page', String(page));
    qs.set('limit', '12');

    apiFetch<{ items: ExpertProfile[]; total: number; totalPages: number }>(`/api/public/experts?${qs.toString()}`)
      .then((d) => {
        setExperts(d.items);
        setTotal(d.total);
        setTotalPages(d.totalPages);
      })
      .finally(() => setLoading(false));
  }, [q, category, method, language, online, minRating, minExperience, maxPrice, sort, page]);

  const updateParam = (key: string, val: string) => {
    const next = new URLSearchParams(searchParams);
    if (val) next.set(key, val);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  };

  const resetFilters = () => {
    setSearchDraft('');
    setSearchParams(new URLSearchParams());
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateParam('q', searchDraft.trim());
  };

  return (
    <div className="w-full bg-[#F7F4EF] min-h-screen py-12">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-8">
        <div className="border-b border-[#25263A]/10 pb-8">
          <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Répertoire des Spécialistes</div>
          <h1 className="mt-1 font-serif text-4xl font-medium text-[#101323]">
            {defaultMethod === 'chat'
              ? 'Conseillers Disponibles en Tchat Direct'
              : defaultMethod === 'phone'
              ? 'Consultations par Ligne Directe'
              : 'Conseillers Spirituels & Astrologues Vérifiés'}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-[#64667A]">
            Filtrez par discipline, présence en temps réel, expérience et profitez de l’offre de bienvenue à 0,00 € sur l’ensemble de nos conseillers.
          </p>
        </div>

        {/* Barre de recherche et filtres */}
        <div className="rounded-lg border border-[#25263A]/10 bg-white p-5 space-y-4">
          <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#64667A]" />
              <input
                type="text"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder="Rechercher par nom, spécialité ou méthode..."
                className="w-full min-h-[42px] rounded-md border border-[#25263A]/20 ps-10 pe-4 text-sm focus:border-[#C7A66A] focus:outline-none"
              />
            </div>
            <Button type="submit">Rechercher</Button>
          </form>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <select
              value={category}
              onChange={(e) => updateParam('category', e.target.value)}
              className="min-h-[40px] rounded-md border border-[#25263A]/20 bg-white px-3 text-xs"
            >
              <option value="">Toutes les spécialités</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>{c.name_fr || c.name_en}</option>
              ))}
            </select>

            <select
              value={method}
              onChange={(e) => updateParam('method', e.target.value)}
              className="min-h-[40px] rounded-md border border-[#25263A]/20 bg-white px-3 text-xs"
            >
              <option value="">Tous les formats</option>
              <option value="chat">Tchat en direct</option>
              <option value="scheduled_appointment">Rendez-vous programmé</option>
              <option value="phone">Ligne téléphonique</option>
            </select>

            <select
              value={minRating}
              onChange={(e) => updateParam('minRating', e.target.value)}
              className="min-h-[40px] rounded-md border border-[#25263A]/20 bg-white px-3 text-xs"
            >
              <option value="">Toutes les notes</option>
              <option value="4.8">4,8+ étoiles</option>
              <option value="4.5">4,5+ étoiles</option>
            </select>

            <select
              value={minExperience}
              onChange={(e) => updateParam('minExperience', e.target.value)}
              className="min-h-[40px] rounded-md border border-[#25263A]/20 bg-white px-3 text-xs"
            >
              <option value="">Toute expérience</option>
              <option value="10">10+ ans</option>
              <option value="15">15+ ans</option>
            </select>

            <select
              value={maxPrice}
              onChange={(e) => updateParam('maxPrice', e.target.value)}
              className="min-h-[40px] rounded-md border border-[#25263A]/20 bg-white px-3 text-xs"
            >
              <option value="">Tous tarifs d’origine</option>
              <option value="30">Moins de 30 €</option>
              <option value="60">Moins de 60 €</option>
            </select>

            <select
              value={sort}
              onChange={(e) => updateParam('sort', e.target.value)}
              className="min-h-[40px] rounded-md border border-[#25263A]/20 bg-white px-3 text-xs font-medium"
            >
              <option value="recommended">Recommandés</option>
              <option value="available_now">Disponibles maintenant</option>
              <option value="highest_rated">Mieux notés</option>
              <option value="lowest_price">Tarif croissant</option>
              <option value="highest_price">Tarif décroissant</option>
              <option value="most_experienced">Plus expérimentés</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-[#64667A]">
            <label className="inline-flex items-center gap-2 cursor-pointer text-[#25263A]">
              <input
                type="checkbox"
                checked={online}
                onChange={(e) => updateParam('online', e.target.checked ? 'true' : '')}
                className="h-4 w-4 accent-[#101323]"
              />
              Afficher uniquement les conseillers en ligne maintenant
            </label>

            <div className="flex items-center gap-4">
              <span className="tabular-nums">{total} conseiller{total > 1 ? 's' : ''} trouvé{total > 1 ? 's' : ''}</span>
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1.5 font-medium text-[#101323] hover:underline"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Réinitialiser les filtres
              </button>
            </div>
          </div>
        </div>

        {/* Grille pleine largeur */}
        {loading ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-[380px] rounded-lg border border-[#25263A]/10 bg-white animate-pulse" />
            ))}
          </div>
        ) : experts.length === 0 ? (
          <EmptyState
            title="Aucun conseiller correspondant"
            description="Modifiez ou réinitialisez vos filtres pour afficher l’ensemble des praticiens vérifiés."
            action={<Button onClick={resetFilters}>Réinitialiser les filtres</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {experts.map((exp) => (
              <ExpertCard key={exp.id} expert={exp} />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => updateParam('page', String(page - 1))}
            >
              Précédent
            </Button>
            <span className="px-4 text-xs font-mono tabular-nums text-[#64667A]">
              Page {page} sur {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => updateParam('page', String(page + 1))}
            >
              Suivant
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
