import { AstralisBackend, type Env } from './backend.ts';

export { AstralisBackend };

/**
 * Entry Worker. Static files (the React app) are served directly by Workers Assets;
 * only the paths listed in `assets.run_worker_first` (API, uploads, WebSocket, SEO files)
 * reach this code, which forwards them to the single backend Durable Object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.BACKEND.get(env.BACKEND.idFromName('main'));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
