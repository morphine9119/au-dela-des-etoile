export type UserRole = 'client' | 'expert' | 'admin' | 'staff';

export interface AuthUser {
  id: string;
  email: string;
  status: string;
  is_demo: boolean;
  roles: UserRole[];
  expertProfileId?: string | null;
  profile?: {
    first_name: string;
    last_name: string;
    phone?: string | null;
    preferred_language: 'en' | 'fr' | 'ar';
    timezone: string;
    marketing_consent: number;
  };
  wallet?: {
    available_cents: number;
    pending_cents: number;
    currency: string;
  };
  loyalty?: {
    points_balance: number;
    lifetime_points: number;
    tier: 'silver' | 'gold' | 'celestial';
    referral_code: string;
  };
}

export interface ExpertService {
  id: string;
  expert_id: string;
  service_type: 'chat_per_message' | 'chat_per_minute' | 'chat_fixed' | 'phone_per_minute' | 'scheduled_appointment';
  title: string;
  description?: string | null;
  price_cents: number;
  currency: string;
  duration_minutes?: number | null;
  is_active: number;
}

export interface ExpertProfile {
  id: string;
  user_id: string;
  slug: string;
  display_name: string;
  headline: string;
  specialty: string;
  category_slug: string;
  biography: string;
  years_experience: number;
  languages: string[];
  tools: string[];
  avatar_url?: string | null;
  cover_url?: string | null;
  intro_video_url?: string | null;
  external_chat_url: string | null;
  is_verified: number;
  is_featured: number;
  status: string;
  presence_status: 'online' | 'busy' | 'offline';
  rating_avg_bp: number;
  review_count: number;
  rating_override_bp?: number | null;
  review_count_override?: number | null;
  completed_consultations: number;
  min_price_cents?: number | null;
  is_demo: number;
  services: ExpertService[];
}

export interface Category {
  id: string;
  slug: string;
  name_en: string;
  name_fr: string;
  name_ar: string;
  description_en: string;
}

export interface Article {
  id: string;
  slug: string;
  category_slug: string;
  author_name: string;
  title: string;
  excerpt: string;
  content: string;
  cover_url?: string | null;
  tags_json?: string;
  status: string;
  published_at: string;
}

export interface TarotCard {
  id: string;
  number: number;
  slug: string;
  name: string;
  arcana: string;
  element: string;
  upright_meaning: string;
  reversed_meaning: string;
  guidance: string;
}

export interface Horoscope {
  id: string;
  sign: string;
  period: 'daily' | 'weekly' | 'monthly' | 'yearly';
  overview: string;
  love_guidance: string;
  career_guidance: string;
  lucky_number: number;
  updated_at: string;
}

export interface ChatConversation {
  id: string;
  consultation_id: string | null;
  client_id: string;
  expert_id: string;
  expert_name?: string;
  expert_slug?: string;
  expert_avatar?: string;
  client_name?: string;
  presence_status?: 'online' | 'busy' | 'offline';
  status: 'open' | 'closed' | 'archived';
  billing_model?: string;
  unit_price_cents?: number;
  consultation_status?: string;
  gross_amount_cents?: number;
  units_consumed?: number;
  last_message?: string;
  unread_count?: number;
  last_message_at?: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  is_read: number;
  billed_cents: number;
  created_at: string;
  first_name?: string;
  last_name?: string;
}
