/**
 * Runtime mode, deliberately independent of NODE_ENV.
 *
 * wrangler/esbuild inlines `process.env.NODE_ENV` at build time from the *build machine's*
 * environment, so relying on it could silently turn a deployment into "development"
 * (demo accounts with public passwords!). Instead the app is secure-by-default:
 * it is in production unless APP_ENV explicitly says otherwise.
 *
 *   APP_ENV=development  -> seeded demo accounts, sandbox payments (local `wrangler dev`)
 *   APP_ENV=test         -> used by the test-suite (also implied by VITEST=true)
 *   anything else/unset  -> production
 */
export type AppEnv = 'production' | 'development' | 'test';

export function appEnv(): AppEnv {
  const value = process.env['APP_ENV'];
  if (value === 'development' || value === 'test') return value;
  if (value === undefined && process.env['VITEST'] === 'true') return 'test';
  return 'production';
}

export function isProduction(): boolean {
  return appEnv() === 'production';
}
