import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Shuffle } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';
import type { Article, Horoscope, TarotCard } from '../../types';
import { Button, SafeImage } from '../../components/ui/Primitives';
import tarotImage from '../../assets/images/editorial_tarot_spread_1794559555868.jpg';

const SIGN_LABELS_FR: Record<string, string> = {
  aries: 'Bélier',
  taurus: 'Taureau',
  gemini: 'Gémeaux',
  cancer: 'Cancer',
  leo: 'Lion',
  virgo: 'Vierge',
  libra: 'Balance',
  scorpio: 'Scorpion',
  sagittarius: 'Sagittaire',
  capricorn: 'Capricorne',
  aquarius: 'Verseau',
  pisces: 'Poissons',
};

const PERIOD_LABELS_FR: Record<'daily' | 'weekly' | 'monthly' | 'yearly', string> = {
  daily: 'Quotidien',
  weekly: 'Hebdomadaire',
  monthly: 'Mensuel',
  yearly: 'Annuel',
};

export function HoroscopePage() {
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('daily');
  const [selectedSign, setSelectedSign] = useState('aries');
  const [horoscopes, setHoroscopes] = useState<Horoscope[]>([]);

  useEffect(() => {
    apiFetch<{ horoscopes: Horoscope[] }>(`/api/public/horoscopes?period=${period}`)
      .then((d) => setHoroscopes(d.horoscopes))
      .catch(() => {});
  }, [period]);

  const active = horoscopes.find((h) => h.sign === selectedSign) || horoscopes[0];

  return (
    <div className="bg-[#F7F4EF] min-h-screen w-full py-12">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-8">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#25263A]/10 pb-8">
          <div>
            <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Éphémérides &amp; Cycles</div>
            <h1 className="mt-1 font-serif text-4xl font-medium text-[#101323]">Horoscopes du Zodiaque</h1>
          </div>

          <div className="flex items-center gap-1 rounded-md border border-[#25263A]/15 bg-white p-1">
            {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`rounded px-3.5 py-1.5 text-xs font-medium transition-colors ${
                  period === p ? 'bg-[#101323] text-[#F7F4EF]' : 'text-[#64667A] hover:text-[#101323]'
                }`}
              >
                {PERIOD_LABELS_FR[p]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-6 lg:grid-cols-12">
          {horoscopes.map((h) => (
            <button
              key={h.sign}
              type="button"
              onClick={() => setSelectedSign(h.sign)}
              className={`rounded-md border px-2 py-3 text-xs font-medium transition-colors ${
                selectedSign === h.sign
                  ? 'border-[#101323] bg-[#101323] text-[#F7F4EF]'
                  : 'border-[#25263A]/10 bg-white text-[#25263A] hover:border-[#C7A66A]'
              }`}
            >
              {SIGN_LABELS_FR[h.sign.toLowerCase()] || h.sign}
            </button>
          ))}
        </div>

        {active && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white p-8 lg:p-10 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#25263A]/10 pb-4">
              <div>
                <div className="text-xs uppercase tracking-widest text-[#C7A66A]">
                  Lecture · {PERIOD_LABELS_FR[period]}
                </div>
                <h2 className="font-serif text-4xl font-medium text-[#101323]">
                  {SIGN_LABELS_FR[active.sign.toLowerCase()] || active.sign}
                </h2>
              </div>
              <div className="text-xs font-mono text-[#64667A] tabular-nums">
                Nombre Harmonique : <span className="text-[#101323] font-semibold">{active.lucky_number}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
              <div className="space-y-2">
                <h3 className="font-serif text-xl font-medium text-[#101323]">Climat Général</h3>
                <p className="text-sm leading-relaxed text-[#25263A]">{active.overview}</p>
              </div>
              <div className="space-y-2">
                <h3 className="font-serif text-xl font-medium text-[#101323]">Relations &amp; Cœur</h3>
                <p className="text-sm leading-relaxed text-[#25263A]">{active.love_guidance}</p>
              </div>
              <div className="space-y-2">
                <h3 className="font-serif text-xl font-medium text-[#101323]">Travail &amp; Projets</h3>
                <p className="text-sm leading-relaxed text-[#25263A]">{active.career_guidance}</p>
              </div>
            </div>

            <div className="border-t border-[#25263A]/10 pt-4 flex justify-end">
              <Link to="/experts?category=astrology" className="text-sm font-medium text-[#101323] hover:underline">
                Consulter un astrologue sur vos transits personnels →
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function TarotPage() {
  const [cards, setCards] = useState<TarotCard[]>([]);
  const [drawn, setDrawn] = useState<Array<{ card: TarotCard; reversed: boolean; position: string }>>([]);

  useEffect(() => {
    apiFetch<{ cards: TarotCard[] }>('/api/public/tarot')
      .then((d) => setCards(d.cards))
      .catch(() => {});
  }, []);

  const drawThreeCards = () => {
    if (cards.length < 3) return;
    const pool = [...cards].sort(() => Math.random() - 0.5).slice(0, 3);
    const positions = ['Situation', 'Tension', 'Intégration'];
    setDrawn(
      pool.map((card, i) => ({
        card,
        reversed: Math.random() < 0.25,
        position: positions[i],
      }))
    );
  };

  return (
    <div className="bg-[#F7F4EF] min-h-screen w-full py-12">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-12">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 items-center border-b border-[#25263A]/10 pb-10">
          <div className="lg:col-span-7 space-y-4">
            <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Étude des Arcanes Majeurs</div>
            <h1 className="font-serif text-4xl font-medium text-[#101323]">Encyclopédie du Tarot &amp; Tirage à 3 Cartes</h1>
            <p className="text-sm leading-relaxed text-[#64667A] max-w-3xl">
              Explorez la structure archétypale des Arcanes Majeurs ou réalisez un tirage réflexif à trois cartes (Situation, Tension, Intégration).
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Button onClick={drawThreeCards}>
                <Shuffle className="h-4 w-4" />
                Tirer 3 Cartes
              </Button>
              <Link
                to="/experts?category=tarot"
                className="inline-flex items-center rounded-md border border-[#25263A]/20 px-5 py-2.5 text-sm font-medium text-[#25263A] hover:bg-white"
              >
                Consulter un spécialiste du Tarot
              </Link>
            </div>
          </div>
          <div className="lg:col-span-5">
            <div className="aspect-[4/3] overflow-hidden rounded-lg border border-[#25263A]/10">
              <SafeImage
                src={tarotImage}
                alt="Cartes de tarot artisanales"
                className="h-full w-full object-cover"
              />
            </div>
          </div>
        </div>

        {/* Tirage Interactif */}
        {drawn.length > 0 && (
          <section className="space-y-4">
            <h2 className="font-serif text-3xl font-medium text-[#101323]">Votre Tirage Réflexif</h2>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              {drawn.map((item) => (
                <div key={item.card.id} className="rounded-lg border border-[#C7A66A]/40 bg-[#101323] p-6 text-[#F7F4EF] space-y-3">
                  <div className="text-xs uppercase tracking-widest text-[#C7A66A]">
                    {item.position} · {item.reversed ? 'Renversée' : 'À l’endroit'}
                  </div>
                  <div className="font-serif text-2xl font-medium">
                    {item.card.number}. {item.card.name}
                  </div>
                  <p className="text-sm leading-relaxed text-[#F7F4EF]/85">
                    {item.reversed ? item.card.reversed_meaning : item.card.upright_meaning}
                  </p>
                  <p className="border-t border-white/10 pt-3 text-xs italic text-[#C7A66A]">
                    {item.card.guidance}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Encyclopédie */}
        <section className="space-y-6">
          <h2 className="font-serif text-3xl font-medium text-[#101323]">Archives des Arcanes Majeurs</h2>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {cards.map((c) => (
              <div key={c.id} className="rounded-lg border border-[#25263A]/10 bg-white p-5 space-y-2">
                <div className="text-xs text-[#64667A]">
                  Arcane {c.number} · {c.element}
                </div>
                <h3 className="font-serif text-2xl font-medium text-[#101323]">{c.name}</h3>
                <p className="text-xs leading-relaxed text-[#25263A]">
                  <span className="font-semibold">À l’endroit :</span> {c.upright_meaning}
                </p>
                <p className="text-xs leading-relaxed text-[#64667A]">
                  <span className="font-semibold">Renversée :</span> {c.reversed_meaning}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export function BlogPage() {
  const { formatDate } = useI18n();
  const [articles, setArticles] = useState<Article[]>([]);
  const [categories, setCategories] = useState<Array<{ slug: string; name: string }>>([]);
  const [selectedCat, setSelectedCat] = useState('');

  useEffect(() => {
    const qs = selectedCat ? `?category=${selectedCat}` : '';
    apiFetch<{ articles: Article[]; categories: Array<{ slug: string; name: string }> }>(`/api/public/articles${qs}`)
      .then((d) => {
        setArticles(d.articles);
        setCategories(d.categories);
      })
      .catch(() => {});
  }, [selectedCat]);

  return (
    <div className="bg-[#F7F4EF] min-h-screen w-full py-12">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-10">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#25263A]/10 pb-8">
          <div>
            <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Revue Éditoriale</div>
            <h1 className="mt-1 font-serif text-4xl font-medium text-[#101323]">Essais sur le Symbolisme &amp; le Temps</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSelectedCat('')}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium ${
                selectedCat === '' ? 'bg-[#101323] text-white' : 'bg-white text-[#25263A] border border-[#25263A]/15'
              }`}
            >
              Tous les Sujets
            </button>
            {categories.map((c) => (
              <button
                key={c.slug}
                type="button"
                onClick={() => setSelectedCat(c.slug)}
                className={`rounded-md px-3.5 py-1.5 text-xs font-medium ${
                  selectedCat === c.slug ? 'bg-[#101323] text-white' : 'bg-white text-[#25263A] border border-[#25263A]/15'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-8 md:grid-cols-3 xl:grid-cols-4">
          {articles.map((art) => (
            <article key={art.id} className="rounded-lg border border-[#25263A]/10 bg-white overflow-hidden flex flex-col">
              <Link to={`/blog/${art.slug}`} className="block aspect-[4/3] bg-[#191E32]">
                <SafeImage src={art.cover_url} alt={art.title} className="h-full w-full object-cover" />
              </Link>
              <div className="p-6 space-y-2.5 flex-1 flex flex-col justify-between">
                <div className="space-y-2">
                  <div className="text-xs text-[#64667A]">
                    {art.author_name} · {formatDate(art.published_at)}
                  </div>
                  <Link to={`/blog/${art.slug}`} className="block font-serif text-2xl font-medium text-[#101323] hover:underline">
                    {art.title}
                  </Link>
                  <p className="text-sm text-[#64667A] leading-relaxed">{art.excerpt}</p>
                </div>
                <Link to={`/blog/${art.slug}`} className="pt-3 text-xs font-medium text-[#101323] hover:underline">
                  Lire l’article →
                </Link>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BlogDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const { formatDate } = useI18n();
  const [article, setArticle] = useState<Article | null>(null);
  const [related, setRelated] = useState<Article[]>([]);

  useEffect(() => {
    if (!slug) return;
    apiFetch<{ article: Article; related: Article[] }>(`/api/public/articles/${slug}`)
      .then((d) => {
        setArticle(d.article);
        setRelated(d.related);
      })
      .catch(() => {});
  }, [slug]);

  if (!article) {
    return <div className="w-full px-6 lg:px-12 xl:px-16 py-16 text-sm text-[#64667A]">Chargement de l’article...</div>;
  }

  return (
    <article className="bg-[#F7F4EF] min-h-screen w-full py-14">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-8">
        <div className="space-y-3 border-b border-[#25263A]/10 pb-6">
          <div className="text-xs uppercase tracking-widest text-[#C7A66A]">
            {article.author_name} · {formatDate(article.published_at)}
          </div>
          <h1 className="font-serif text-4xl sm:text-5xl font-medium text-[#101323] leading-tight">
            {article.title}
          </h1>
          <p className="text-lg text-[#64667A] max-w-4xl">{article.excerpt}</p>
        </div>

        <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 items-start">
          <div className="lg:col-span-5">
            <div className="aspect-[4/3] overflow-hidden rounded-lg bg-[#191E32]">
              <SafeImage src={article.cover_url} alt={article.title} className="h-full w-full object-cover" />
            </div>
          </div>
          <div className="lg:col-span-7 space-y-5 text-base leading-[1.85] text-[#25263A] whitespace-pre-line bg-white rounded-lg border border-[#25263A]/10 p-6 lg:p-10">
            {article.content}
          </div>
        </div>

        {related.length > 0 && (
          <div className="border-t border-[#25263A]/10 pt-10 space-y-4">
            <h3 className="font-serif text-2xl font-medium text-[#101323]">Articles Similaires</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((r) => (
                <Link key={r.id} to={`/blog/${r.slug}`} className="rounded-md border border-[#25263A]/10 bg-white p-5 hover:border-[#C7A66A]">
                  <div className="text-xs text-[#64667A]">{r.author_name}</div>
                  <div className="mt-1 font-serif text-xl text-[#101323]">{r.title}</div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
