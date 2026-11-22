import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../lib/api';
import { AlertBanner, Button, Input } from '../../components/ui/Primitives';

export function LoginPage() {
  const { user, login, logout } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de la connexion');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full bg-[#F7F4EF] min-h-[calc(100vh-80px)] flex items-center justify-center py-12 px-6 lg:px-12">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center space-y-2">
          <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Accès Sécurisé</div>
          <h1 className="font-serif text-4xl font-medium text-[#101323]">Connexion</h1>
          <p className="text-sm text-[#64667A]">
            Connectez-vous à votre espace personnel client, conseiller ou administrateur.
          </p>
        </div>

        {user && (
          <AlertBanner tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Connecté actuellement en tant que <strong>{user.email}</strong>.
              </span>
              <div className="flex items-center gap-3">
                <Link
                  to={user.roles.includes('admin') ? '/admin' : user.roles.includes('expert') ? '/expert/dashboard' : '/account'}
                  className="font-semibold text-[#101323] underline"
                >
                  Mon Espace
                </Link>
                <button type="button" onClick={() => logout()} className="text-xs underline text-[#64667A] hover:text-[#101323]">
                  Se déconnecter
                </button>
              </div>
            </div>
          </AlertBanner>
        )}

        <form onSubmit={handleSubmit} className="rounded-lg border border-[#25263A]/10 bg-white p-6 md:p-8 space-y-4">
          {error && <AlertBanner tone="error">{error}</AlertBanner>}
          <Input
            label="Nom d'utilisateur ou adresse e-mail"
            type="text"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="caroline"
            className="placeholder:!text-[#64667A]/40"
          />
          <div className="space-y-1.5">
            <label htmlFor="login-password" className="block text-xs font-medium tracking-wide text-[#25263A]">
              Mot de Passe
            </label>
            <div className="relative">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full min-h-[42px] rounded-md border border-[#25263A]/20 bg-white px-3.5 py-2 pr-10 text-sm text-[#25263A] placeholder:text-[#64667A]/40 focus:border-[#C7A66A] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                className="absolute inset-y-0 end-0 flex items-center px-3 text-[#64667A] hover:text-[#101323]"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs">
            <Link to="/forgot-password" className="text-[#64667A] hover:text-[#101323]">
              Mot de passe oublié ?
            </Link>
            <Link to="/register" className="font-medium text-[#101323] hover:underline">
              Créer un compte
            </Link>
          </div>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Connexion en cours...' : 'Se Connecter'}
          </Button>
        </form>

      </div>
    </div>
  );
}

export function RegisterPage() {
  const { user, register, logout } = useAuth();
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsError, setTermsError] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError('Veuillez saisir votre prénom et votre nom.');
      return;
    }
    if (password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    if (!termsAccepted) {
      setTermsError(true);
      return;
    }
    setBusy(true);
    try {
      await register({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        password,
        termsAccepted,
        marketingConsent,
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de la création du compte');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full bg-[#F7F4EF] min-h-[calc(100vh-80px)] flex items-center justify-center py-12 px-6 lg:px-12">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center space-y-2">
          <div className="text-xs font-medium tracking-widest uppercase text-[#C7A66A]">Nouveau Membre</div>
          <h1 className="font-serif text-4xl font-medium text-[#101323]">Créer un Compte</h1>
          <p className="text-sm text-[#64667A]">
            Chaque inscription crée un compte unique et indépendant, avec accès immédiat à l’offre gratuite à 0,00 €.
          </p>
        </div>

        {user && (
          <AlertBanner tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Vous êtes déjà connecté avec <strong>{user.email}</strong>. Créer un compte ouvrira une nouvelle session indépendante.
              </span>
              <button type="button" onClick={() => logout()} className="text-xs underline text-[#101323]">
                Se déconnecter d’abord
              </button>
            </div>
          </AlertBanner>
        )}

        <form onSubmit={handleSubmit} className="rounded-lg border border-[#25263A]/10 bg-white p-6 md:p-8 space-y-4">
          {error && <AlertBanner tone="error">{error}</AlertBanner>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Prénom"
              required
              autoComplete="given-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
            <Input
              label="Nom"
              required
              autoComplete="family-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>
          <Input
            label="Numéro de Téléphone"
            type="tel"
            required
            autoComplete="tel"
            minLength={6}
            maxLength={40}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+33 6 12 34 56 78"
          />
          <Input
            label="Adresse E-mail"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nom@exemple.fr"
          />
          <div className="space-y-1.5">
            <label htmlFor="register-password" className="block text-xs font-medium tracking-wide text-[#25263A]">
              Mot de Passe (8 caractères minimum)
            </label>
            <div className="relative">
              <input
                id="register-password"
                type={showPassword ? 'text' : 'password'}
                minLength={8}
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8 caractères minimum"
                className="w-full min-h-[42px] rounded-md border border-[#25263A]/20 bg-white px-3.5 py-2 pr-10 text-sm text-[#25263A] placeholder:text-[#64667A]/70 focus:border-[#C7A66A] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                className="absolute inset-y-0 end-0 flex items-center px-3 text-[#64667A] hover:text-[#101323]"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <label className="flex items-start gap-2 text-xs text-[#64667A]">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(e) => {
                  setTermsAccepted(e.target.checked);
                  if (e.target.checked) setTermsError(false);
                }}
                aria-required="true"
                aria-invalid={termsError}
                className="mt-0.5"
              />
              <span>
                J’accepte les <Link to="/terms" className="underline text-[#101323]">Conditions Générales</Link> et la{' '}
                <Link to="/privacy" className="underline text-[#101323]">Politique de Confidentialité</Link> (obligatoire).
              </span>
            </label>
            {termsError && (
              <p role="alert" className="ms-5 text-xs text-[#991B1B]">
                Veuillez accepter les Conditions Générales et la Politique de Confidentialité.
              </p>
            )}
          </div>
          <label className="flex items-start gap-2 text-xs text-[#64667A]">
            <input type="checkbox" checked={marketingConsent} onChange={(e) => setMarketingConsent(e.target.checked)} className="mt-0.5" />
            <span>J’accepte de recevoir occasionnellement la lettre éditoriale (facultatif, sans incidence sur l’inscription).</span>
          </label>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Création du compte...' : 'Créer mon Compte & Recevoir 100 Points'}
          </Button>
          <div className="text-center text-xs text-[#64667A]">
            Vous avez déjà un compte ?{' '}
            <Link to="/login" className="font-medium text-[#101323] hover:underline">
              Se Connecter
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setMsg(res.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full bg-[#F7F4EF] min-h-[calc(100vh-80px)] flex items-center justify-center py-12 px-6 lg:px-12">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="font-serif text-4xl font-medium text-[#101323]">Réinitialiser le Mot de Passe</h1>
        </div>
        <form onSubmit={handleSubmit} className="rounded-lg border border-[#25263A]/10 bg-white p-6 md:p-8 space-y-4">
          {msg && <AlertBanner tone="info">{msg}</AlertBanner>}
          <Input label="Adresse E-mail du compte" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" className="w-full" disabled={busy}>
            Envoyer le lien de réinitialisation
          </Button>
          <div className="text-center text-xs">
            <Link to="/login" className="text-[#101323] hover:underline">Retour à la connexion</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
