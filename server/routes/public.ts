import { Router } from '../http/express-lite.ts';
import { z } from 'zod';
import { db, nowIso, uuid } from '../db.ts';
import { getAvailableSlotsForDate } from '../services/availability.ts';
import { getAllProviderStatuses } from '../services/paymentGateway.ts';
import { getTelephonyProviderStatus } from '../services/telephonyAdapter.ts';

export const publicRouter = Router();

publicRouter.get('/bootstrap', (_req, res) => {
  const settingsRows = db.prepare('SELECT key, value_json FROM platform_settings').all() as Array<{ key: string; value_json: string }>;
  const settings: Record<string, unknown> = {};
  for (const r of settingsRows) {
    settings[r.key] = JSON.parse(r.value_json);
  }
  const categories = db.prepare('SELECT * FROM expert_categories WHERE is_active = 1 ORDER BY sort_order ASC').all();
  res.json({
    settings,
    categories,
    paymentProviders: getAllProviderStatuses(),
    telephony: getTelephonyProviderStatus(),
  });
});

publicRouter.get('/stats', (_req, res) => {
  const expertsCount = (db.prepare("SELECT COUNT(*) as c FROM expert_profiles WHERE status = 'approved'").get() as { c: number }).c;
  const completedCount = (db.prepare("SELECT COALESCE(SUM(completed_consultations), 0) as c FROM expert_profiles WHERE status = 'approved'").get() as { c: number }).c;
  const reviewsCount = (db.prepare("SELECT COUNT(*) as c FROM reviews WHERE status = 'published'").get() as { c: number }).c;
  const demoExperts = (db.prepare("SELECT COUNT(*) as c FROM expert_profiles WHERE status = 'approved' AND is_demo = 1").get() as { c: number }).c;
  const homepageStatsRow = db.prepare("SELECT value_json FROM platform_settings WHERE key = 'homepage_stats'").get() as
    | { value_json: string }
    | undefined;
  const homepageStats = homepageStatsRow
    ? JSON.parse(homepageStatsRow.value_json) as {
        verifiedExperts: number | null;
        completedConsultations: number | null;
        publishedReviews: number | null;
      }
    : null;
  res.json({
    verifiedExperts: homepageStats?.verifiedExperts ?? expertsCount,
    completedConsultations: homepageStats?.completedConsultations ?? completedCount,
    publishedReviews: homepageStats?.publishedReviews ?? reviewsCount,
    includesDemoData: homepageStats?.verifiedExperts == null && demoExperts > 0,
  });
});

publicRouter.get('/experts', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const method = typeof req.query.method === 'string' ? req.query.method.trim() : '';
  const language = typeof req.query.language === 'string' ? req.query.language.trim() : '';
  const onlineOnly = req.query.online === 'true';
  const minRating = Number(req.query.minRating || 0);
  const minExperience = Number(req.query.minExperience || 0);
  const maxPriceCents = req.query.maxPriceCents ? Number(req.query.maxPriceCents) : null;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'recommended';
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(24, Math.max(1, Number(req.query.limit || 12)));

  const rows = db
    .prepare(`
      SELECT ep.*,
        (SELECT MIN(price_cents) FROM expert_services es WHERE es.expert_id = ep.id AND es.is_active = 1) as min_price_cents
      FROM expert_profiles ep
      WHERE ep.status = 'approved'
    `)
    .all() as Array<Record<string, unknown> & {
      id: string;
      display_name: string;
      headline: string;
      specialty: string;
      category_slug: string;
      biography: string;
      years_experience: number;
      languages_json: string;
      tools_json: string;
      presence_status: string;
      rating_avg_bp: number;
      rating_override_bp: number | null;
      review_count: number;
      review_count_override: number | null;
      is_featured: number;
      min_price_cents: number | null;
    }>;

  const servicesByExpert = new Map<string, unknown[]>();
  const allServices = db.prepare('SELECT * FROM expert_services WHERE is_active = 1').all() as Array<{ expert_id: string; service_type: string; price_cents: number }>;
  for (const s of allServices) {
    if (!servicesByExpert.has(s.expert_id)) servicesByExpert.set(s.expert_id, []);
    servicesByExpert.get(s.expert_id)!.push(s);
  }

  let filtered = rows.map((r) => ({
    ...r,
    rating_avg_bp: r.rating_override_bp ?? r.rating_avg_bp,
    review_count: r.review_count_override ?? r.review_count,
    languages: JSON.parse(r.languages_json) as string[],
    tools: JSON.parse(r.tools_json) as string[],
    services: (servicesByExpert.get(r.id) || []) as Array<{ service_type: string; price_cents: number }>,
  }));

  if (q) {
    filtered = filtered.filter(
      (e) =>
        e.display_name.toLowerCase().includes(q) ||
        e.specialty.toLowerCase().includes(q) ||
        e.headline.toLowerCase().includes(q) ||
        e.biography.toLowerCase().includes(q)
    );
  }
  if (category) {
    filtered = filtered.filter((e) => e.category_slug === category);
  }
  if (language) {
    filtered = filtered.filter((e) => e.languages.includes(language));
  }
  if (onlineOnly) {
    filtered = filtered.filter((e) => e.presence_status === 'online');
  }
  if (method) {
    filtered = filtered.filter((e) =>
      e.services.some((s) =>
        method === 'chat'
          ? s.service_type.startsWith('chat_')
          : method === 'phone'
          ? s.service_type === 'phone_per_minute'
          : s.service_type === method
      )
    );
  }
  if (minRating > 0) {
    filtered = filtered.filter((e) => e.rating_avg_bp >= minRating * 100);
  }
  if (minExperience > 0) {
    filtered = filtered.filter((e) => e.years_experience >= minExperience);
  }
  if (maxPriceCents !== null && !Number.isNaN(maxPriceCents) && maxPriceCents > 0) {
    filtered = filtered.filter((e) => (e.min_price_cents ?? 0) <= maxPriceCents);
  }

  filtered.sort((a, b) => {
    switch (sort) {
      case 'highest_rated':
        return b.rating_avg_bp - a.rating_avg_bp;
      case 'lowest_price':
        return (a.min_price_cents ?? 999999) - (b.min_price_cents ?? 999999);
      case 'highest_price':
        return (b.min_price_cents ?? 0) - (a.min_price_cents ?? 0);
      case 'most_experienced':
        return b.years_experience - a.years_experience;
      case 'available_now':
        return (a.presence_status === 'online' ? 0 : 1) - (b.presence_status === 'online' ? 0 : 1);
      default:
        return b.is_featured - a.is_featured || (a.presence_status === 'online' ? 0 : 1) - (b.presence_status === 'online' ? 0 : 1) || b.rating_avg_bp - a.rating_avg_bp;
    }
  });

  const total = filtered.length;
  const start = (page - 1) * limit;
  const items = filtered.slice(start, start + limit);

  res.json({ items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

publicRouter.get('/experts/:slug', (req, res) => {
  const expert = db
    .prepare("SELECT * FROM expert_profiles WHERE slug = ? AND status = 'approved'")
    .get(req.params.slug) as
    | (Record<string, unknown> & {
        id: string;
        languages_json: string;
        tools_json: string;
        rating_avg_bp: number;
        rating_override_bp: number | null;
        review_count: number;
        review_count_override: number | null;
      })
    | undefined;

  if (!expert) {
    res.status(404).json({ error: 'Conseiller introuvable' });
    return;
  }

  const services = db.prepare('SELECT * FROM expert_services WHERE expert_id = ? AND is_active = 1 ORDER BY price_cents ASC').all(expert.id);
  const availability = db.prepare('SELECT * FROM expert_availability WHERE expert_id = ? ORDER BY day_of_week ASC, start_time ASC').all(expert.id);
  const reviews = db
    .prepare(`
      SELECT r.id, r.rating, r.comment, r.expert_reply, r.is_demo, r.created_at,
        cp.first_name as client_first_name
      FROM reviews r
      LEFT JOIN client_profiles cp ON cp.user_id = r.client_id
      WHERE r.expert_id = ? AND r.status = 'published'
      ORDER BY r.created_at DESC
      LIMIT 20
    `)
    .all(expert.id);

  const ratingBreakdownRows = db
    .prepare("SELECT rating, COUNT(*) as count FROM reviews WHERE expert_id = ? AND status = 'published' GROUP BY rating")
    .all(expert.id) as Array<{ rating: number; count: number }>;
  const ratingBreakdown: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const r of ratingBreakdownRows) ratingBreakdown[r.rating] = r.count;

  res.json({
    expert: {
      ...expert,
      rating_avg_bp: expert.rating_override_bp ?? expert.rating_avg_bp,
      review_count: expert.review_count_override ?? expert.review_count,
      languages: JSON.parse(expert.languages_json),
      tools: JSON.parse(expert.tools_json),
      services,
      availability,
      reviews,
      ratingBreakdown,
    },
    telephony: getTelephonyProviderStatus(),
  });
});

publicRouter.get('/experts/:slug/slots', (req, res) => {
  const expert = db.prepare("SELECT id FROM expert_profiles WHERE slug = ? AND status = 'approved'").get(req.params.slug) as
    | { id: string }
    | undefined;
  if (!expert) {
    res.status(404).json({ error: 'Conseiller introuvable' });
    return;
  }
  const dateStr = typeof req.query.date === 'string' ? req.query.date : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const duration = Number(req.query.duration || 45);
  const slots = getAvailableSlotsForDate(expert.id, dateStr, duration);
  res.json({ date: dateStr, slots });
});

publicRouter.post('/recommendations', (req, res) => {
  const { subject, guidanceType, method, language } = req.body || {};
  const categoryMap: Record<string, string> = {
    love: 'tarot',
    career: 'numerology',
    timing: 'astrology',
    clarity: 'mediumship',
    decisions: 'cartomancy',
  };
  const targetCat = categoryMap[String(subject || '')] || '';

  const rows = db
    .prepare("SELECT * FROM expert_profiles WHERE status = 'approved'")
    .all() as Array<Record<string, unknown> & { id: string; category_slug: string; languages_json: string; tools_json: string; presence_status: string; rating_avg_bp: number }>;

  const services = db.prepare('SELECT expert_id, service_type, price_cents FROM expert_services WHERE is_active = 1').all() as Array<{
    expert_id: string;
    service_type: string;
    price_cents: number;
  }>;

  const scored = rows.map((e) => {
    const langs = JSON.parse(e.languages_json) as string[];
    const svcs = services.filter((s) => s.expert_id === e.id);
    let score = 0;
    if (targetCat && e.category_slug === targetCat) score += 40;
    if (language && langs.includes(language)) score += 30;
    if (method && svcs.some((s) => (method === 'chat' ? s.service_type.startsWith('chat_') : s.service_type === method))) score += 20;
    if (guidanceType === 'structured' && e.category_slug === 'astrology') score += 10;
    if (e.presence_status === 'online') score += 10;
    score += Math.round(e.rating_avg_bp / 100);
    return {
      ...e,
      languages: langs,
      tools: JSON.parse(e.tools_json),
      services: svcs,
      min_price_cents: svcs.length ? Math.min(...svcs.map((s) => s.price_cents)) : 0,
      matchScore: score,
    };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore);
  res.json({ recommendations: scored.slice(0, 3) });
});

publicRouter.get('/articles', (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const rows = category
    ? db.prepare("SELECT * FROM articles WHERE status = 'published' AND category_slug = ? ORDER BY published_at DESC").all(category)
    : db.prepare("SELECT * FROM articles WHERE status = 'published' ORDER BY published_at DESC").all();
  const categories = db.prepare('SELECT * FROM article_categories ORDER BY name ASC').all();
  res.json({ articles: rows, categories });
});

publicRouter.get('/articles/:slug', (req, res) => {
  const article = db.prepare("SELECT * FROM articles WHERE slug = ? AND status = 'published'").get(req.params.slug) as
    | (Record<string, unknown> & { category_slug: string; id: string })
    | undefined;
  if (!article) {
    res.status(404).json({ error: 'Article introuvable' });
    return;
  }
  const related = db
    .prepare("SELECT id, slug, title, excerpt, cover_url, published_at, author_name FROM articles WHERE status = 'published' AND id != ? LIMIT 3")
    .all(article.id);
  res.json({ article, related });
});

publicRouter.get('/horoscopes', (req, res) => {
  const period = typeof req.query.period === 'string' ? req.query.period : 'daily';
  const sign = typeof req.query.sign === 'string' ? req.query.sign.toLowerCase() : '';
  const rows = sign
    ? db.prepare('SELECT * FROM horoscopes WHERE period = ? AND sign = ? ORDER BY sign ASC').all(period, sign)
    : db.prepare('SELECT * FROM horoscopes WHERE period = ? ORDER BY sign ASC').all(period);
  res.json({ horoscopes: rows, period });
});

publicRouter.get('/tarot', (_req, res) => {
  const cards = db.prepare('SELECT * FROM tarot_cards ORDER BY number ASC').all();
  res.json({ cards });
});

publicRouter.get('/faqs', (_req, res) => {
  const faqs = db.prepare('SELECT * FROM faqs WHERE is_published = 1 ORDER BY sort_order ASC').all();
  res.json({ faqs });
});

publicRouter.post('/newsletter', (req, res) => {
  const parsed = z.object({ email: z.string().email(), language: z.enum(['en', 'fr', 'ar']).optional().default('fr') }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Une adresse e-mail valide est requise' });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  db.prepare('INSERT OR IGNORE INTO newsletter_subscribers (id, email, language, created_at) VALUES (?, ?, ?, ?)')
    .run(uuid(), email, 'fr', nowIso());
  res.json({ ok: true, message: 'Inscription confirmée à la lettre éditoriale Au-delà des Étoiles.' });
});

publicRouter.post('/contact', (req, res) => {
  const schema = z.object({
    name: z.string().min(2).max(100),
    email: z.string().email(),
    subject: z.string().min(2).max(160),
    message: z.string().min(10).max(3000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Demande de contact invalide' });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const userId = req.authUser?.email.toLowerCase() === email ? req.authUser.id : null;
  const ts = nowIso();
  db.prepare('INSERT INTO contact_messages (id, name, email, subject, message, status, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), parsed.data.name.trim(), email, parsed.data.subject.trim(), parsed.data.message.trim(), 'in_progress', ts, ts, userId);
  res.status(201).json({ ok: true, message: 'Votre message a bien été transmis à notre équipe de conciergerie.' });
});

publicRouter.post('/expert-applications', (req, res) => {
  const schema = z.object({
    fullName: z.string().min(2).max(120),
    displayName: z.string().min(2).max(120),
    email: z.string().email(),
    phone: z.string().min(6).max(40),
    country: z.string().min(2).max(80),
    languages: z.array(z.string()).min(1),
    specialties: z.array(z.string()).min(1),
    yearsExperience: z.number().int().min(1).max(70),
    biography: z.string().min(40).max(4000),
    methods: z.array(z.string()).min(1),
    portfolioUrl: z.string().max(300).optional().default(''),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Veuillez remplir tous les champs obligatoires de candidature' });
    return;
  }
  const ts = nowIso();
  const id = uuid();
  const email = parsed.data.email.trim().toLowerCase();
  const userId = req.authUser?.email.toLowerCase() === email ? req.authUser.id : null;
  db.prepare(`
    INSERT INTO expert_applications (id, user_id, full_name, display_name, email, phone, country, languages_json, specialties_json, years_experience, biography, methods_json, portfolio_url, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)
  `).run(
    id,
    userId,
    parsed.data.fullName.trim(),
    parsed.data.displayName.trim(),
    email,
    parsed.data.phone.trim(),
    parsed.data.country.trim(),
    JSON.stringify(parsed.data.languages),
    JSON.stringify(parsed.data.specialties),
    parsed.data.yearsExperience,
    parsed.data.biography.trim(),
    JSON.stringify(parsed.data.methods),
    parsed.data.portfolioUrl.trim() || null,
    ts,
    ts
  );
  res.status(201).json({ ok: true, applicationId: id });
});
