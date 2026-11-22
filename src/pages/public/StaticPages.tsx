import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../../lib/api';
import { AlertBanner, Button, Input, Textarea } from '../../components/ui/Primitives';

export function AboutPage() {
  return (
    <div className="bg-[#F7F4EF] min-h-screen w-full py-14">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-6">
        <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Notre Philosophie</div>
        <h1 className="font-serif text-4xl font-medium text-[#101323]">
          Une maison exigeante dédiée au conseil symbolique et astrologique.
        </h1>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 pt-2">
          <div className="rounded-lg border border-[#25263A]/10 bg-white p-8 space-y-4">
            <p className="text-base leading-relaxed text-[#25263A]">
              Au-delà des Étoiles met en relation les personnes en quête de discernement avec des praticiens rigoureusement sélectionnés en astrologie classique, tarot, numérologie pythagoricienne et guidance intuitive.
            </p>
            <p className="text-base leading-relaxed text-[#64667A]">
              Nous proscrivons les témoignages fabriqués, les comptes à rebours manipulateurs et toute facturation opaque. Chaque consultation affiche son tarif transparent avant le démarrage, avec une offre découverte à 0,00 € et un suivi vérifié par le système.
            </p>
          </div>
          <div className="rounded-lg bg-[#101323] p-8 text-[#F7F4EF] flex flex-col justify-between space-y-6">
            <div className="space-y-3">
              <div className="text-xs uppercase tracking-widest text-[#C7A66A]">Engagements de la Maison</div>
              <ul className="space-y-2 text-sm text-[#F7F4EF]/85">
                <li>· Praticiens audités et vérifiés individuellement</li>
                <li>· Confidentialité stricte des échanges privés</li>
                <li>· Offre de bienvenue à 0,00 € sans engagement</li>
                <li>· Accès direct par téléphone via notre ligne centrale dédiée</li>
              </ul>
            </div>
            <div>
              <Link to="/experts" className="inline-block rounded-md bg-[#C7A66A] px-6 py-3 text-sm font-semibold text-[#101323]">
                Découvrir nos Conseillers Vérifiés
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ContactPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ message: string }>('/api/public/contact', {
        method: 'POST',
        body: JSON.stringify({ name, email, subject, message }),
      });
      setSent(res.message);
      setName('');
      setEmail('');
      setSubject('');
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible d’envoyer votre message');
    }
  };

  return (
    <div className="bg-[#F7F4EF] min-h-screen w-full py-14">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-8">
        <div>
          <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Conciergerie &amp; Support</div>
          <h1 className="mt-1 font-serif text-4xl font-medium text-[#101323]">Contacter Au-delà des Étoiles</h1>
        </div>
        {sent && <AlertBanner tone="success">{sent}</AlertBanner>}
        {error && <AlertBanner tone="error">{error}</AlertBanner>}
        <form onSubmit={handleSubmit} className="rounded-lg border border-[#25263A]/10 bg-white p-6 md:p-10 space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Votre Nom" required value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Adresse E-mail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Input label="Objet" required value={subject} onChange={(e) => setSubject(e.target.value)} />
          <Textarea label="Message" rows={5} required value={message} onChange={(e) => setMessage(e.target.value)} />
          <Button type="submit">Envoyer la Demande</Button>
        </form>
      </div>
    </div>
  );
}

export function FaqPage() {
  const [faqs, setFaqs] = useState<Array<{ id: string; category: string; question: string; answer: string }>>([]);
  useEffect(() => {
    apiFetch<{ faqs: Array<{ id: string; category: string; question: string; answer: string }> }>('/api/public/faqs')
      .then((d) => setFaqs(d.faqs))
      .catch(() => {});
  }, []);

  return (
    <div className="bg-[#F7F4EF] min-h-screen w-full py-14">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-8">
        <div>
          <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Centre d’Aide</div>
          <h1 className="mt-1 font-serif text-4xl font-medium text-[#101323]">Foire Aux Questions</h1>
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {faqs.map((f) => (
            <div key={f.id} className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-2">
              <div className="text-xs uppercase tracking-wider text-[#C7A66A]">{f.category}</div>
              <h2 className="font-serif text-2xl font-medium text-[#101323]">{f.question}</h2>
              <p className="text-sm leading-relaxed text-[#64667A]">{f.answer}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LegalPage({ type }: { type: 'privacy' | 'terms' | 'cookies' }) {
  const titles = {
    privacy: 'Politique de Confidentialité & Droits RGPD',
    terms: 'Conditions Générales de Consultation & Gouvernance Financière',
    cookies: 'Notice sur les Cookies & Sécurité des Sessions',
  };
  return (
    <div className="bg-[#F7F4EF] min-h-screen w-full py-14">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-6">
        <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Gouvernance Légale</div>
        <h1 className="font-serif text-4xl font-medium text-[#101323]">{titles[type]}</h1>
        <div className="rounded-lg border border-[#25263A]/10 bg-white p-8 lg:p-10 space-y-4 text-sm leading-relaxed text-[#25263A]">
          {type === 'privacy' && (
            <>
              <p>
                Nous collectons uniquement les données personnelles strictement nécessaires à la réalisation des consultations demandées, à la planification des rendez-vous et à la tenue des registres comptables réglementaires.
              </p>
              <p>
                Les échanges privés de consultation sont accessibles exclusivement aux participants autorisés de la séance. Les clients authentifiés peuvent exporter ou supprimer les données de leur compte directement depuis les Paramètres du Compte conformément au RGPD.
              </p>
            </>
          )}
          {type === 'terms' && (
            <>
              <p>
                L’ensemble des consultations spirituelles, astrologiques et de tarot constituent des services de conseil réflexif et ne sauraient se substituer à un avis médical, juridique ou financier réglementé.
              </p>
              <p>
                La tarification des séances est vérifiée côté serveur en centimes d’euro, avec application transparente des offres promotionnelles actives. Les paiements externes réels requièrent des identifiants prestataires configurés et une vérification cryptographique.
              </p>
            </>
          )}
          {type === 'cookies' && (
            <p>
              Au-delà des Étoiles utilise exclusivement des cookies de session HTTP-only strictement nécessaires à l’authentification sécurisée et à la continuité de votre espace personnel en langue française.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
