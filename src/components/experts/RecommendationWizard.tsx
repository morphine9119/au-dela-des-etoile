import React, { useState } from 'react';
import { apiFetch } from '../../lib/api';
import type { ExpertProfile } from '../../types';
import { Button } from '../ui/Primitives';
import { ExpertCard } from './ExpertCard';

export function RecommendationWizard() {
  const [subject, setSubject] = useState('love');
  const [guidanceType, setGuidanceType] = useState('structured');
  const [method, setMethod] = useState('chat');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ExpertProfile[] | null>(null);

  const handleMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await apiFetch<{ recommendations: ExpertProfile[] }>('/api/public/recommendations', {
        method: 'POST',
        body: JSON.stringify({ subject, guidanceType, method, language: 'fr' }),
      });
      setResults(data.recommendations);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full rounded-lg border border-[#25263A]/10 bg-white p-6 md:p-8">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 items-start">
        <form onSubmit={handleMatch} className="lg:col-span-4 space-y-5">
          <div>
            <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Orientation Guidée</div>
            <h3 className="mt-1 font-serif text-3xl font-medium text-[#101323]">
              Trouver le conseiller adapté
            </h3>
            <p className="mt-2 text-sm text-[#64667A]">
              Sélectionnez votre thématique et votre format préféré pour obtenir une sélection personnalisée de spécialistes.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#25263A] mb-1.5">Sujet de consultation</label>
              <select
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full min-h-[40px] rounded-md border border-[#25263A]/20 bg-[#F7F4EF]/50 px-3 text-sm"
              >
                <option value="love">Relations &amp; Synastrie</option>
                <option value="career">Carrière &amp; Vocation</option>
                <option value="timing">Cycles &amp; Transitions</option>
                <option value="decisions">Décisions Concrètes</option>
                <option value="clarity">Réflexion Personnelle</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#25263A] mb-1.5">Approche souhaitée</label>
              <select
                value={guidanceType}
                onChange={(e) => setGuidanceType(e.target.value)}
                className="w-full min-h-[40px] rounded-md border border-[#25263A]/20 bg-[#F7F4EF]/50 px-3 text-sm"
              >
                <option value="structured">Thème / Matrice Structurée</option>
                <option value="symbolic">Tirage Symbolique de Tarot</option>
                <option value="reflective">Dialogue Réflexif</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#25263A] mb-1.5">Format préféré</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-full min-h-[40px] rounded-md border border-[#25263A]/20 bg-[#F7F4EF]/50 px-3 text-sm"
              >
                <option value="chat">Tchat privé en temps réel</option>
                <option value="scheduled_appointment">Rendez-vous programmé</option>
              </select>
            </div>
          </div>

          <Button type="submit" disabled={loading}>
            {loading ? 'Analyse en cours...' : 'Afficher les conseillers recommandés'}
          </Button>
        </form>

        <div className="lg:col-span-8">
          {!results ? (
            <div className="rounded-md border border-dashed border-[#25263A]/15 bg-[#F7F4EF]/60 p-10 text-center">
              <div className="font-serif text-2xl text-[#101323]">Sélection Personnalisée</div>
              <p className="mt-2 text-sm text-[#64667A]">
                Choisissez vos critères à gauche pour découvrir jusqu’à trois conseillers vérifiés disponibles selon votre discipline et votre format.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
              {results.map((exp) => (
                <ExpertCard key={exp.id} expert={exp} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
