import React, { createContext, useContext, useEffect, useState } from 'react';
import { brandConfig } from '../config/brand';
import { apiFetch } from '../lib/api';
import { translations, type Locale } from './translations';

interface I18nContextValue {
  locale: Locale;
  t: (key: string) => string;
  formatCurrency: (cents: number, currency?: string) => string;
  formatDate: (iso: string) => string;
  mainNumber: string;
  freeOfferEnabled: boolean;
  refreshPlatformConfig: () => Promise<void>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale: Locale = 'fr';
  const [mainNumber, setMainNumber] = useState<string>(brandConfig.mainNumber);
  const [freeOfferEnabled, setFreeOfferEnabled] = useState<boolean>(true);

  const refreshPlatformConfig = async () => {
    try {
      const data = await apiFetch<{ settings: Record<string, unknown> }>('/api/public/bootstrap');
      if (typeof data.settings?.main_number === 'string' && data.settings.main_number.trim()) {
        setMainNumber(data.settings.main_number.trim());
      }
      if (typeof data.settings?.free_offer_enabled === 'boolean') {
        setFreeOfferEnabled(data.settings.free_offer_enabled);
      }
    } catch {
      // keep default
    }
  };

  useEffect(() => {
    document.documentElement.lang = 'fr';
    document.documentElement.dir = 'ltr';
    refreshPlatformConfig();
  }, []);

  const t = (key: string): string => {
    return translations.fr[key] ?? key;
  };

  const formatCurrency = (cents: number, currency = 'EUR'): string => {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(cents / 100);
  };

  const formatDate = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('fr-FR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(d);
  };

  return (
    <I18nContext.Provider
      value={{
        locale,
        t,
        formatCurrency,
        formatDate,
        mainNumber,
        freeOfferEnabled,
        refreshPlatformConfig,
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
