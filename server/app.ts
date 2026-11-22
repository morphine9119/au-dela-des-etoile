import { attachAuth } from './auth.ts';
import { db } from './db.ts';
import { App } from './http/express-lite.ts';
import { adminRouter } from './routes/admin.ts';
import { authRouter } from './routes/auth.ts';
import { clientRouter } from './routes/client.ts';
import { expertRouter } from './routes/expert.ts';
import { publicRouter } from './routes/public.ts';

/** Builds the HTTP API. Pure Web-standard (Request -> Response); runs on Workers and in Node. */
export function createApp(): App {
  const app = new App({ jsonLimit: 8 * 1024 * 1024 });
  app.use(attachAuth);

  // Expert avatars are stored in the database (see uploaded_files).
  app.get('/uploads/expert-avatars/:filename', (req, res) => {
    const row = db.prepare('SELECT mime_type, data FROM uploaded_files WHERE filename = ?').get(req.params.filename) as
      | { mime_type: string; data: Uint8Array | ArrayBuffer }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Fichier introuvable' });
      return;
    }
    res
      .set('Content-Type', row.mime_type)
      .set('Cache-Control', 'public, max-age=31536000, immutable')
      .set('X-Content-Type-Options', 'nosniff')
      .send(row.data);
  });

  // SEO endpoints
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /expert\nDisallow: /admin\nSitemap: /sitemap.xml\n');
  });

  app.get('/sitemap.xml', (req, res) => {
    const host = req.headers.host || 'localhost';
    const baseUrl = `${req.secure ? 'https' : 'http'}://${host}`;
    const staticPaths = ['/', '/experts', '/horoscope', '/tarot', '/blog', '/become-an-expert', '/about', '/contact', '/faq'];
    const urls = staticPaths.map((p) => `<url><loc>${baseUrl}${p}</loc></url>`).join('');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  });

  // API routes
  app.use('/api/auth', authRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/client', clientRouter);
  app.use('/api/expert', expertRouter);
  app.use('/api/admin', adminRouter);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  return app;
}
