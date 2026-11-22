export type TelephonyProviderId = 'twilio' | 'vonage' | 'webrtc';

export interface TelephonyProviderStatus {
  id: TelephonyProviderId;
  name: string;
  isConfigured: boolean;
  setupRequirement: string;
  recordingPolicy: string;
}

export function getTelephonyProviderStatus(): TelephonyProviderStatus {
  const hasTwilio = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_CALLER_ID);
  if (hasTwilio) {
    return {
      id: 'twilio',
      name: 'Twilio Programmable Voice',
      isConfigured: true,
      setupRequirement: 'Configured',
      recordingPolicy: 'Call recording disabled by default; requires explicit legal consent.',
    };
  }

  const hasVonage = Boolean(process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET);
  if (hasVonage) {
    return {
      id: 'vonage',
      name: 'Vonage Voice API',
      isConfigured: true,
      setupRequirement: 'Configured',
      recordingPolicy: 'Call recording disabled by default; requires explicit legal consent.',
    };
  }

  return {
    id: 'twilio',
    name: 'External Telephony Adapter (Twilio / Vonage / SIP)',
    isConfigured: false,
    setupRequirement: 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_CALLER_ID (or VONAGE_API_KEY / VONAGE_API_SECRET) to activate live voice calls.',
    recordingPolicy: 'Call recording disabled by default; explicit consent required before enabling.',
  };
}
