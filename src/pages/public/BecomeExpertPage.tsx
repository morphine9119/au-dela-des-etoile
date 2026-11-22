import React, { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { AlertBanner, Button, Input, Textarea } from '../../components/ui/Primitives';

const SPECIALTY_OPTIONS = [
  'Astrologie',
  'Tarot',
  'Numérologie',
  'Cartomancie',
  'Guidance Intuitive',
];

const LANGUAGE_OPTIONS = [
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'Anglais' },
  { code: 'ar', label: 'Arabe' },
];

type ApplicationField =
  | 'fullName'
  | 'displayName'
  | 'email'
  | 'phone'
  | 'country'
  | 'yearsExperience'
  | 'languages'
  | 'specialties'
  | 'methods'
  | 'portfolioUrl'
  | 'biography';

type ApplicationFieldErrors = Partial<Record<ApplicationField, string>>;

export function BecomeExpertPage() {
  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('France');
  const [yearsExperience, setYearsExperience] = useState(5);
  const [languages, setLanguages] = useState<string[]>(['fr']);
  const [specialties, setSpecialties] = useState<string[]>(['Astrologie']);
  const [methods, setMethods] = useState<string[]>(['chat', 'scheduled_appointment']);
  const [biography, setBiography] = useState('');
  const [portfolioUrl, setPortfolioUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ApplicationFieldErrors>({});
  const [submittedId, setSubmittedId] = useState<string | null>(null);

  const clearFieldError = (field: ApplicationField) => {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const toggleItem = (list: string[], setList: React.Dispatch<React.SetStateAction<string[]>>, val: string) => {
    setList(list.includes(val) ? list.filter((i) => i !== val) : [...list, val]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const errors: ApplicationFieldErrors = {};
    const trimmedEmail = email.trim();
    const trimmedBiography = biography.trim();

    if (fullName.trim().length < 2 || fullName.trim().length > 120) {
      errors.fullName = 'Le nom complet doit contenir entre 2 et 120 caractères.';
    }
    if (displayName.trim().length < 2 || displayName.trim().length > 120) {
      errors.displayName = 'Le nom public doit contenir entre 2 et 120 caractères.';
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errors.email = 'Saisissez une adresse e-mail valide.';
    }
    if (phone.trim().length < 6 || phone.trim().length > 40) {
      errors.phone = 'Le numéro de téléphone doit contenir entre 6 et 40 caractères.';
    }
    if (country.trim().length < 2 || country.trim().length > 80) {
      errors.country = 'Le pays doit contenir entre 2 et 80 caractères.';
    }
    if (!Number.isInteger(yearsExperience) || yearsExperience < 1 || yearsExperience > 70) {
      errors.yearsExperience = 'Indiquez un nombre d’années compris entre 1 et 70.';
    }
    if (languages.length === 0) errors.languages = 'Sélectionnez au moins une langue.';
    if (specialties.length === 0) errors.specialties = 'Sélectionnez au moins une discipline.';
    if (methods.length === 0) errors.methods = 'Sélectionnez au moins un mode de consultation.';
    if (portfolioUrl.trim().length > 300) errors.portfolioUrl = 'Le lien ne doit pas dépasser 300 caractères.';
    if (trimmedBiography.length < 40 || trimmedBiography.length > 4000) {
      errors.biography = 'La biographie doit contenir entre 40 et 4 000 caractères.';
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const res = await apiFetch<{ applicationId: string }>('/api/public/expert-applications', {
        method: 'POST',
        body: JSON.stringify({
          fullName: fullName.trim(),
          displayName: displayName.trim(),
          email: trimmedEmail,
          phone: phone.trim(),
          country: country.trim(),
          languages,
          specialties,
          yearsExperience: Number(yearsExperience),
          biography: trimmedBiography,
          methods,
          portfolioUrl: portfolioUrl.trim(),
        }),
      });
      setSubmittedId(res.applicationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible d’envoyer votre candidature');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-[#F7F4EF] min-h-screen w-full py-14">
      <div className="w-full px-6 lg:px-12 xl:px-16 space-y-8">
        <div className="border-b border-[#25263A]/10 pb-6 space-y-2">
          <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Recrutement des Conseillers</div>
          <h1 className="font-serif text-4xl font-medium text-[#101323]">Rejoindre l’équipe d’Au-delà des Étoiles</h1>
          <p className="text-sm text-[#64667A] max-w-3xl">
            Chaque dossier de candidature fait l’objet d’une vérification éditoriale et déontologique par notre équipe d’administration avant l’activation du compte conseiller.
          </p>
        </div>

        {submittedId ? (
          <AlertBanner tone="success">
            <div className="font-medium">Candidature enregistrée ({submittedId.slice(0, 8)})</div>
            <p className="mt-1">
              Votre dossier est désormais en file d’attente auprès de notre commission d’administration. Dès validation, votre espace conseiller sera activé.
            </p>
          </AlertBanner>
        ) : (
          <form noValidate onSubmit={handleSubmit} className="rounded-lg border border-[#25263A]/10 bg-white p-6 md:p-10 space-y-6">
            {error && <AlertBanner tone="error">{error}</AlertBanner>}

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Input
                label="Nom Légal Complet"
                required
                maxLength={120}
                value={fullName}
                error={fieldErrors.fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  clearFieldError('fullName');
                }}
              />
              <Input
                label="Nom Public d’Exercice"
                required
                maxLength={120}
                value={displayName}
                error={fieldErrors.displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  clearFieldError('displayName');
                }}
              />
              <Input
                label="Adresse E-mail"
                type="email"
                required
                maxLength={254}
                value={email}
                error={fieldErrors.email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearFieldError('email');
                }}
              />
              <Input
                label="Numéro de Téléphone"
                required
                minLength={6}
                maxLength={40}
                value={phone}
                error={fieldErrors.phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  clearFieldError('phone');
                }}
              />
              <Input
                label="Pays d’Exercice"
                required
                minLength={2}
                maxLength={80}
                value={country}
                error={fieldErrors.country}
                onChange={(e) => {
                  setCountry(e.target.value);
                  clearFieldError('country');
                }}
              />
              <Input
                label="Années d’Expérience"
                type="number"
                min={1}
                max={70}
                required
                value={yearsExperience}
                error={fieldErrors.yearsExperience}
                onChange={(e) => {
                  setYearsExperience(Number(e.target.value));
                  clearFieldError('yearsExperience');
                }}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              <div>
                <div className="text-xs font-medium text-[#25263A] mb-2">Langues Parlées</div>
                {LANGUAGE_OPTIONS.map((lang) => (
                  <label key={lang.code} className="flex items-center gap-2 text-sm py-1">
                    <input
                      type="checkbox"
                      checked={languages.includes(lang.code)}
                      onChange={() => {
                        toggleItem(languages, setLanguages, lang.code);
                        clearFieldError('languages');
                      }}
                    />
                    <span>{lang.label}</span>
                  </label>
                ))}
                {fieldErrors.languages && <p role="alert" className="mt-1 text-xs text-[#991B1B]">{fieldErrors.languages}</p>}
              </div>

              <div>
                <div className="text-xs font-medium text-[#25263A] mb-2">Disciplines Principales</div>
                {SPECIALTY_OPTIONS.map((sp) => (
                  <label key={sp} className="flex items-center gap-2 text-sm py-1">
                    <input
                      type="checkbox"
                      checked={specialties.includes(sp)}
                      onChange={() => {
                        toggleItem(specialties, setSpecialties, sp);
                        clearFieldError('specialties');
                      }}
                    />
                    <span>{sp}</span>
                  </label>
                ))}
                {fieldErrors.specialties && <p role="alert" className="mt-1 text-xs text-[#991B1B]">{fieldErrors.specialties}</p>}
              </div>

              <div>
                <div className="text-xs font-medium text-[#25263A] mb-2">Modes de Consultation</div>
                {[
                  ['chat', 'Tchat en Direct'],
                  ['scheduled_appointment', 'Séances Planifiées'],
                  ['phone', 'Consultations Téléphoniques'],
                ].map(([val, lbl]) => (
                  <label key={val} className="flex items-center gap-2 text-sm py-1">
                    <input
                      type="checkbox"
                      checked={methods.includes(val)}
                      onChange={() => {
                        toggleItem(methods, setMethods, val);
                        clearFieldError('methods');
                      }}
                    />
                    <span>{lbl}</span>
                  </label>
                ))}
                {fieldErrors.methods && <p role="alert" className="mt-1 text-xs text-[#991B1B]">{fieldErrors.methods}</p>}
              </div>
            </div>

            <Input
              label="Portfolio, Publications ou Lien CV (Optionnel)"
              value={portfolioUrl}
              maxLength={300}
              error={fieldErrors.portfolioUrl}
              onChange={(e) => {
                setPortfolioUrl(e.target.value);
                clearFieldError('portfolioUrl');
              }}
              placeholder="https://..."
            />

            <Textarea
              label="Biographie Professionnelle & Méthodologie (min. 40 caractères)"
              rows={5}
              required
              minLength={40}
              maxLength={4000}
              value={biography}
              error={fieldErrors.biography}
              onChange={(e) => {
                setBiography(e.target.value);
                clearFieldError('biography');
              }}
              placeholder="Décrivez votre parcours, votre déontologie et vos outils d’analyse..."
            />

            <div className="flex justify-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Envoi de la candidature...' : 'Soumettre ma Candidature'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
