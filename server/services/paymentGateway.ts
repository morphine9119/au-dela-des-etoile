import { isProduction } from '../env.ts';
import crypto from 'node:crypto';

export type PaymentProviderId = 'stripe' | 'paytabs' | 'cmi' | 'paypal' | 'sandbox_demo';

export interface PaymentProviderInfo {
  id: PaymentProviderId;
  name: string;
  methods: string[];
  supportedCountries: string[];
  isConfigured: boolean;
  setupRequirement: string;
}

const PROVIDER_AVAILABILITY: Array<Omit<PaymentProviderInfo, 'isConfigured'>> = [
  {
    id: 'stripe',
    name: 'Stripe (Cards, Apple Pay, Google Pay)',
    methods: ['card', 'apple_pay', 'google_pay'],
    supportedCountries: ['FR', 'GB', 'DE', 'ES', 'IT', 'BE', 'CH', 'CA', 'US', 'AE'],
    setupRequirement: 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in environment variables.',
  },
  {
    id: 'cmi',
    name: 'CMI / Local Moroccan Cards',
    methods: ['card', 'local_bank'],
    supportedCountries: ['MA'],
    setupRequirement: 'Set CMI_MERCHANT_ID and CMI_STORE_KEY in environment variables.',
  },
  {
    id: 'paytabs',
    name: 'PayTabs MENA Gateway (Mada, Local Cards)',
    methods: ['card', 'mada', 'apple_pay'],
    supportedCountries: ['SA', 'AE', 'EG', 'JO', 'OM', 'KW'],
    setupRequirement: 'Set PAYTABS_PROFILE_ID and PAYTABS_SERVER_KEY in environment variables.',
  },
  {
    id: 'paypal',
    name: 'PayPal Digital Wallet',
    methods: ['digital_wallet'],
    supportedCountries: ['FR', 'GB', 'DE', 'ES', 'IT', 'BE', 'CH', 'CA', 'US', 'MA', 'AE'],
    setupRequirement: 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in environment variables.',
  },
];

export function isProviderConfigured(providerId: PaymentProviderId): boolean {
  switch (providerId) {
    case 'stripe':
      return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
    case 'cmi':
      return Boolean(process.env.CMI_MERCHANT_ID && process.env.CMI_STORE_KEY);
    case 'paytabs':
      return Boolean(process.env.PAYTABS_PROFILE_ID && process.env.PAYTABS_SERVER_KEY);
    case 'paypal':
      return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
    case 'sandbox_demo':
      return !isProduction() || process.env.ENABLE_DEMO_SANDBOX === 'true';
    default:
      return false;
  }
}

export function getAvailableProvidersForCountry(countryCode: string): PaymentProviderInfo[] {
  const normalized = countryCode.toUpperCase();
  return PROVIDER_AVAILABILITY.filter((p) => p.supportedCountries.includes(normalized)).map((p) => ({
    ...p,
    isConfigured: isProviderConfigured(p.id),
  }));
}

export function getAllProviderStatuses(): PaymentProviderInfo[] {
  return PROVIDER_AVAILABILITY.map((p) => ({
    ...p,
    isConfigured: isProviderConfigured(p.id),
  }));
}

export function verifyWebhookSignature(params: {
  provider: PaymentProviderId;
  rawBody: string;
  signatureHeader?: string;
}): boolean {
  if (!params.signatureHeader) return false;
  const secretMap: Record<string, string | undefined> = {
    stripe: process.env.STRIPE_WEBHOOK_SECRET,
    paytabs: process.env.PAYTABS_SERVER_KEY,
    cmi: process.env.CMI_STORE_KEY,
    paypal: process.env.PAYPAL_WEBHOOK_ID,
  };
  const secret = secretMap[params.provider];
  if (!secret) return false;

  const expected = crypto.createHmac('sha256', secret).update(params.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(params.signatureHeader));
  } catch {
    return false;
  }
}
