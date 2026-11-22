import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { brandConfig } from '../../config/brand';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';

export function Footer() {
  const { t, mainNumber } = useI18n();
  const [email, setEmail] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setStatusMsg(null);
    try {
      const res = await apiFetch<{ message: string }>('/api/public/newsletter', {
        method: 'POST',
        body: JSON.stringify({ email, language: 'fr' }),
      });
      setStatusMsg(res.message);
      setEmail('');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Échec de l’inscription');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <footer className="w-full border-t border-[#25263A]/10 bg-[#101323] text-[#F7F4EF]">
      <div className="w-full px-6 py-16 lg:px-12 xl:px-16">
        <div className="grid grid-cols-1 gap-10 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2 space-y-4">
            <div className="font-serif text-2xl font-semibold tracking-tight text-[#F7F4EF]">
              {brandConfig.name}
            </div>
            <p className="max-w-md text-sm leading-relaxed text-[#F7F4EF]/75">
              Plateforme privée de consultations en astrologie classique, tarot, numérologie pythagoricienne et guidance intuitive en langue française.
            </p>
            <div className="text-xs text-[#C7A66A]">
              Ligne directe centrale (Main Number) :{' '}
              <a href={`tel:${mainNumber}`} className="font-mono font-semibold text-[#F7F4EF] hover:underline">
                {mainNumber}
              </a>
            </div>
            <form onSubmit={handleSubscribe} className="pt-2">
              <label htmlFor="newsletter-email" className="block text-xs font-medium tracking-wider uppercase text-[#C7A66A]">
                Lettre Éditoriale
              </label>
              <div className="mt-2 flex max-w-md gap-2">
                <input
                  id="newsletter-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nom@exemple.fr"
                  className="w-full rounded-md border border-white/15 bg-[#191E32] px-3.5 py-2 text-sm text-[#F7F4EF] placeholder:text-[#F7F4EF]/40 focus:border-[#C7A66A] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-md bg-[#C7A66A] px-4 py-2 text-xs font-semibold text-[#101323] hover:bg-[#B49154] whitespace-nowrap shrink-0"
                >
                  {submitting ? 'Envoi...' : "S'inscrire"}
                </button>
              </div>
              {statusMsg && <p className="mt-2 text-xs text-[#C7A66A]">{statusMsg}</p>}
            </form>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-widest text-[#C7A66A]">Spécialités</h4>
            <ul className="space-y-2 text-sm text-[#F7F4EF]/80">
              <li><Link to="/experts?category=astrology" className="hover:text-white">Astrologie Natale</Link></li>
              <li><Link to="/experts?category=tarot" className="hover:text-white">Tarot &amp; Arcanes</Link></li>
              <li><Link to="/experts?category=numerology" className="hover:text-white">Numérologie</Link></li>
              <li><Link to="/experts?category=mediumship" className="hover:text-white">Guidance Intuitive</Link></li>
              <li><Link to="/experts/chat" className="hover:text-white">Tchat en Direct</Link></li>
            </ul>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-widest text-[#C7A66A]">Plateforme</h4>
            <ul className="space-y-2 text-sm text-[#F7F4EF]/80">
              <li><Link to="/about" className="hover:text-white">À Propos</Link></li>
              <li><Link to="/become-an-expert" className="hover:text-white">Devenir Conseiller</Link></li>
              <li><Link to="/faq" className="hover:text-white">Foire aux Questions</Link></li>
              <li><Link to="/contact" className="hover:text-white">Service Client</Link></li>
            </ul>
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-widest text-[#C7A66A]">Informations Légales</h4>
            <ul className="space-y-2 text-sm text-[#F7F4EF]/80">
              <li><Link to="/privacy" className="hover:text-white">Politique de Confidentialité</Link></li>
              <li><Link to="/terms" className="hover:text-white">Conditions Générales</Link></li>
              <li><Link to="/cookies" className="hover:text-white">Politique de Cookies</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-8 text-xs text-[#F7F4EF]/60 sm:flex-row sm:items-center sm:justify-between">
          <div>© {new Date().getFullYear()} {brandConfig.legalEntity}. {t('footer_rights')}</div>
          <div>{t('demo_notice')}</div>
        </div>
      </div>
    </footer>
  );
}
