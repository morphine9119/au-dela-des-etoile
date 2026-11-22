import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Users,
  UserCheck,
  FileText,
  ShieldAlert,
  PhoneCall,
  ImagePlus,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Trash2,
  X,
  LifeBuoy,
} from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';
import { supportStatusBadgeClass } from '../../lib/supportStatusMessages';
import { useAuth } from '../../context/AuthContext';
import { DashboardShell, type NavItem } from '../../components/layout/DashboardShell';
import { AdminSupportMessenger } from '../../components/support/AdminSupportMessenger';
import { AlertBanner, Button, Input, Modal, Select, Textarea } from '../../components/ui/Primitives';

const AVATAR_WIDTH = 600;
const AVATAR_HEIGHT = 800;
const MAX_SOURCE_IMAGE_BYTES = 15 * 1024 * 1024;
const ADMIN_USERS_LAST_SEEN_KEY = 'admin-users-last-seen';

interface AvatarEditorImage {
  element: HTMLImageElement;
  name: string;
}

interface ExpertProfileDraft {
  id: string;
  displayName: string;
  headline: string;
  specialty: string;
  biography: string;
  yearsExperience: string;
  completedConsultations: string;
  languages: string;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function drawAvatarPreview(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  zoom: number,
  rotation: number,
  offsetX: number,
  offsetY: number
) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Impossible de préparer l’aperçu de l’image');

  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const baseScale = Math.max(
    (AVATAR_WIDTH * cosine + AVATAR_HEIGHT * sine) / image.naturalWidth,
    (AVATAR_WIDTH * sine + AVATAR_HEIGHT * cosine) / image.naturalHeight
  );

  canvas.width = AVATAR_WIDTH;
  canvas.height = AVATAR_HEIGHT;
  context.fillStyle = '#191E32';
  context.fillRect(0, 0, AVATAR_WIDTH, AVATAR_HEIGHT);
  context.save();
  context.translate(AVATAR_WIDTH / 2 + offsetX, AVATAR_HEIGHT / 2 + offsetY);
  context.rotate(radians);
  context.scale(baseScale * zoom, baseScale * zoom);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  context.restore();
}

const ROUTE_TO_TAB: Record<string, string> = {
  '/admin/': 'experts',
  '/admin/users': 'users',
  '/admin/clients': 'users',
  '/admin/experts': 'experts',
  '/admin/applications': 'applications',
  '/admin/consultations': 'consultations',
  '/admin/financials': 'financials',
  '/admin/payments': 'financials',
  '/admin/refunds': 'financials',
  '/admin/commissions': 'commissions',
  '/admin/wallets': 'financials',
  '/admin/rewards': 'rewards',
  '/admin/coupons': 'rewards',
  '/admin/reviews': 'experts',
  '/admin/experts/reviews': 'experts',
  '/admin/content': 'content',
  '/admin/blog': 'content',
  '/admin/horoscopes': 'content',
  '/admin/support': 'support',
  '/admin/messenger': 'messenger',
  '/admin/audit-logs': 'audit',
  '/admin/settings': 'content',
};

const STATUS_FR: Record<string, string> = {
  submitted: 'Soumise',
  under_review: 'En cours d’examen',
  interview: 'Entretien',
  approved: 'Approuvé',
  rejected: 'Refusée',
  activated: 'Activée',
  suspended: 'Suspendu',
  active: 'Actif',
  pending: 'En attente',
  paid: 'Payé',
  requested: 'Demandé',
  processed: 'Traité',
  published: 'Publié',
  removed: 'Retiré',
  flagged: 'Signalé',
  open: 'Ouvert',
  new: 'En cours',
  in_progress: 'En cours',
  waiting_customer: 'En attente',
  resolved: 'Résolu',
  closed: 'Clôturé',
  completed: 'Terminée',
};

const APPLICATION_LANGUAGE_LABELS: Record<string, string> = {
  fr: 'Français',
  en: 'Anglais',
  ar: 'Arabe',
};

const APPLICATION_METHOD_LABELS: Record<string, string> = {
  chat: 'Tchat en Direct',
  scheduled_appointment: 'Séances Planifiées',
  phone: 'Consultations Téléphoniques',
};

function formatApplicationList(value: unknown, labels: Record<string, string> = {}): string {
  if (typeof value !== 'string') return 'Donnée invalide';
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return 'Donnée invalide';
    return parsed.map((item: string) => labels[item] || item).join(', ') || 'Aucun';
  } catch {
    return 'Donnée invalide';
  }
}

function getSafeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function AdminDashboard() {
  const { formatCurrency, formatDate, mainNumber, freeOfferEnabled, refreshPlatformConfig } = useI18n();
  const { hasRole, user } = useAuth();
  const canDeleteUsers = hasRole('admin');
  const canDeleteAuditLogs = canDeleteUsers;
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = ROUTE_TO_TAB[location.pathname] || 'experts';
  const expertSection = location.pathname === '/admin/reviews' || location.pathname === '/admin/experts/reviews'
    ? 'reviews'
    : 'directory';
  const [usersLastSeenAt, setUsersLastSeenAt] = useState(() => (
    window.localStorage.getItem(ADMIN_USERS_LAST_SEEN_KEY) || new Date().toISOString()
  ));
  const setTab = (id: string) => {
    const map: Record<string, string> = {
      overview: '/admin/experts',
      audit: '/admin/audit-logs',
      rewards: '/admin/coupons',
      content: '/admin/settings',
      messenger: '/admin/messenger',
    };
    if (id === 'users') {
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(ADMIN_USERS_LAST_SEEN_KEY, timestamp);
      setUsersLastSeenAt(timestamp);
    }
    navigate(map[id] || `/admin/${id}`);
  };

  const [overview, setOverview] = useState<Record<string, number> | null>(null);
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [experts, setExperts] = useState<Array<Record<string, unknown>>>([]);
  const [expertReviewStats, setExpertReviewStats] = useState<Record<string, { rating: string; count: string }>>({});
  const [savingReviewStatsId, setSavingReviewStatsId] = useState<string | null>(null);
  const [expertExternalLinks, setExpertExternalLinks] = useState<Record<string, string>>({});
  const [savingExpertLink, setSavingExpertLink] = useState<string | null>(null);
  const [savingExpertPresenceId, setSavingExpertPresenceId] = useState<string | null>(null);
  const [editingExpertProfile, setEditingExpertProfile] = useState<ExpertProfileDraft | null>(null);
  const [savingExpertProfile, setSavingExpertProfile] = useState(false);
  const [avatarExpert, setAvatarExpert] = useState<Record<string, unknown> | null>(null);
  const [avatarImage, setAvatarImage] = useState<AvatarEditorImage | null>(null);
  const [avatarZoom, setAvatarZoom] = useState(1);
  const [avatarRotation, setAvatarRotation] = useState(0);
  const [avatarOffset, setAvatarOffset] = useState({ x: 0, y: 0 });
  const [avatarDrag, setAvatarDrag] = useState<{
    clientX: number;
    clientY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const avatarCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const [applications, setApplications] = useState<Array<Record<string, unknown>>>([]);
  const [deletingApplicationId, setDeletingApplicationId] = useState<string | null>(null);
  const [consultations, setConsultations] = useState<Array<Record<string, unknown>>>([]);
  const [financials, setFinancials] = useState<Record<string, Array<Record<string, unknown>>> | null>(null);
  const [content, setContent] = useState<Record<string, Array<Record<string, unknown>>> | null>(null);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [deletingAuditLog, setDeletingAuditLog] = useState<string | null>(null);
  const [clearingAuditLogs, setClearingAuditLogs] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [processingTicketId, setProcessingTicketId] = useState<string | null>(null);

  // Paramètres Centraux (Main Number & Offre Gratuite)
  const [mainNumberInput, setMainNumberInput] = useState(mainNumber);
  const [freeOfferInput, setFreeOfferInput] = useState(freeOfferEnabled);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [homepageStatsInput, setHomepageStatsInput] = useState({
    verifiedExperts: '',
    completedConsultations: '',
    publishedReviews: '',
  });
  const [savingHomepageStats, setSavingHomepageStats] = useState(false);

  // Formulaires
  const [userSearch, setUserSearch] = useState('');
  const [newExpertForm, setNewExpertForm] = useState({
    displayName: '',
    specialty: 'Tarot',
    status: 'suspended' as 'approved' | 'pending' | 'suspended' | 'rejected',
    presenceStatus: 'offline' as 'online' | 'offline',
  });
  const [creatingExpert, setCreatingExpert] = useState(false);
  const [removingExpertId, setRemovingExpertId] = useState<string | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [newRuleScope, setNewRuleScope] = useState('global');
  const [newRuleRatePct, setNewRuleRatePct] = useState('25');
  const [newRuleDesc, setNewRuleDesc] = useState('');
  const [newCouponCode, setNewCouponCode] = useState('');
  const [newCouponValue, setNewCouponValue] = useState('1000');
  useEffect(() => {
    if (!avatarExpert) return;
    setAvatarImage(null);
    setAvatarZoom(1);
    setAvatarRotation(0);
    setAvatarOffset({ x: 0, y: 0 });
    setAvatarError(null);
    if (typeof avatarExpert.avatar_url !== 'string' || !avatarExpert.avatar_url) return;

    const image = new Image();
    image.onload = () => setAvatarImage({ element: image, name: String(avatarExpert.display_name) });
    image.onerror = () => setAvatarError('Impossible de charger la photo actuelle. Vous pouvez en importer une nouvelle.');
    image.src = avatarExpert.avatar_url;
  }, [avatarExpert]);

  useEffect(() => {
    if (avatarCanvasRef.current && avatarImage) {
      drawAvatarPreview(
        avatarCanvasRef.current,
        avatarImage.element,
        avatarZoom,
        avatarRotation,
        avatarOffset.x,
        avatarOffset.y
      );
    }
  }, [avatarImage, avatarZoom, avatarRotation, avatarOffset]);

  useEffect(() => {
    setMainNumberInput(mainNumber);
    setFreeOfferInput(freeOfferEnabled);
  }, [mainNumber, freeOfferEnabled]);

  const handleAvatarFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const extension = file.name.split('.').pop()?.toLowerCase();
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp'];
    if ((!allowedTypes.includes(file.type) && file.type !== '') || !allowedExtensions.includes(extension || '')) {
      setAvatarError('Formats acceptés : JPG, JPEG, PNG et WebP.');
      return;
    }
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      setAvatarError('La photo doit faire moins de 15 Mo.');
      return;
    }

    setAvatarError(null);
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      setAvatarImage({ element: image, name: file.name });
      setAvatarZoom(1);
      setAvatarRotation(0);
      setAvatarOffset({ x: 0, y: 0 });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setAvatarError('Ce fichier ne peut pas être lu comme une image.');
    };
    image.src = objectUrl;
  };

  const handleSaveAvatar = async () => {
    if (!avatarExpert || !avatarImage || !avatarCanvasRef.current) return;
    setAvatarError(null);
    setAvatarSaving(true);
    try {
      drawAvatarPreview(
        avatarCanvasRef.current,
        avatarImage.element,
        avatarZoom,
        avatarRotation,
        avatarOffset.x,
        avatarOffset.y
      );
      const imageDataUrl = avatarCanvasRef.current.toDataURL('image/webp', 0.9);
      if (!imageDataUrl.startsWith('data:image/webp;')) {
        throw new Error('Votre navigateur ne peut pas optimiser cette image au format WebP.');
      }
      const expertId = String(avatarExpert.id);
      const result = await apiFetch<{ avatarUrl: string }>(`/api/admin/experts/${expertId}/avatar`, {
        method: 'POST',
        body: JSON.stringify({ imageDataUrl }),
      });
      setExperts((current) =>
        current.map((expert) => expert.id === expertId ? { ...expert, avatar_url: result.avatarUrl } : expert)
      );
      setAvatarExpert(null);
      setBanner({ tone: 'success', text: `Photo de profil de ${String(avatarExpert.display_name)} mise à jour.` });
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Impossible d’enregistrer la photo');
    } finally {
      setAvatarSaving(false);
    }
  };

  const handleRemoveAvatar = async () => {
    if (!avatarExpert) return;
    setAvatarError(null);
    setAvatarSaving(true);
    try {
      const expertId = String(avatarExpert.id);
      await apiFetch(`/api/admin/experts/${expertId}/avatar`, { method: 'DELETE' });
      setExperts((current) =>
        current.map((expert) => expert.id === expertId ? { ...expert, avatar_url: null } : expert)
      );
      setAvatarExpert(null);
      setBanner({ tone: 'success', text: `Photo retirée. L’image par défaut est rétablie pour ${String(avatarExpert.display_name)}.` });
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Impossible de retirer la photo');
    } finally {
      setAvatarSaving(false);
    }
  };

  const loadAdminData = async (): Promise<boolean> => {
    try {
      const [ov, us, ex, ap, co, fi, ct] = await Promise.all([
        apiFetch<Record<string, number>>(`/api/admin/overview?usersSince=${encodeURIComponent(usersLastSeenAt)}`),
        apiFetch<{ users: Array<Record<string, unknown>> }>(`/api/admin/users?q=${encodeURIComponent(userSearch)}`),
        apiFetch<{ experts: Array<Record<string, unknown>> }>('/api/admin/experts'),
        canDeleteUsers
          ? apiFetch<{ applications: Array<Record<string, unknown>> }>('/api/admin/applications')
          : Promise.resolve({ applications: [] }),
        apiFetch<{ consultations: Array<Record<string, unknown>> }>('/api/admin/consultations'),
        apiFetch<Record<string, Array<Record<string, unknown>>>>('/api/admin/financials'),
        apiFetch<Record<string, Array<Record<string, unknown>>>>('/api/admin/content'),
      ]);
      setOverview(ov);
      setUsers(us.users);
      setExperts(ex.experts);
      setExpertReviewStats(
        Object.fromEntries(
          ex.experts.map((expert) => [
            String(expert.id),
            {
              rating: (Number(expert.rating_override_bp ?? expert.rating_avg_bp ?? 0) / 100).toFixed(2),
              count: String(expert.review_count_override ?? expert.review_count ?? 0),
            },
          ])
        )
      );
      setExpertExternalLinks(Object.fromEntries(
        ex.experts.map((expert) => [String(expert.id), String(expert.external_chat_url || '')])
      ));
      setApplications(ap.applications);
      setConsultations(co.consultations);
      setFinancials(fi);
      setContent(ct);

      const settingsRows = (ct.settings || []) as Array<{ key: string; value_json: string }>;
      const mnRow = settingsRows.find((s) => s.key === 'main_number');
      if (mnRow) {
        try {
          setMainNumberInput(String(JSON.parse(mnRow.value_json)));
        } catch {
          // ignore
        }
      }
      const foRow = settingsRows.find((s) => s.key === 'free_offer_enabled');
      if (foRow) {
        try {
          setFreeOfferInput(Boolean(JSON.parse(foRow.value_json)));
        } catch {
          // ignore
        }
      }
      const homepageStatsRow = settingsRows.find((s) => s.key === 'homepage_stats');
      if (homepageStatsRow) {
        const stats = JSON.parse(homepageStatsRow.value_json) as {
          verifiedExperts: number | null;
          completedConsultations: number | null;
          publishedReviews: number | null;
        };
        setHomepageStatsInput({
          verifiedExperts: stats.verifiedExperts == null ? '' : String(stats.verifiedExperts),
          completedConsultations: stats.completedConsultations == null ? '' : String(stats.completedConsultations),
          publishedReviews: stats.publishedReviews == null ? '' : String(stats.publishedReviews),
        });
      }
      return true;
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de charger la console d’administration' });
      return false;
    }
  };

  const loadSupportTickets = async (): Promise<boolean> => {
    try {
      const { tickets } = await apiFetch<{ tickets: Array<Record<string, unknown>> }>('/api/admin/support');
      setContent((currentContent) => currentContent ? { ...currentContent, tickets } : currentContent);
      return true;
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de charger les tickets support' });
      return false;
    }
  };

  const refreshAdminOverview = async (): Promise<void> => {
    try {
      const latestOverview = await apiFetch<Record<string, number>>(
        `/api/admin/overview?usersSince=${encodeURIComponent(usersLastSeenAt)}`
      );
      setOverview(latestOverview);
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’actualiser les notifications' });
    }
  };

  const handleSupportStatus = async (
    ticket: Record<string, unknown>,
    status: 'in_progress' | 'resolved' | 'closed'
  ) => {
    const id = String(ticket.id);
    const source = ticket.source === 'contact' ? 'contact' : 'support';
    setProcessingTicketId(`${source}:${id}`);
    setBanner(null);
    try {
      await apiFetch(`/api/admin/support/${source}/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await loadSupportTickets();
      if (status === 'in_progress') {
        navigate('/admin/messenger', { state: { supportTicket: { source, id } } });
        return;
      }
      setBanner({
        tone: 'success',
        text: status === 'resolved'
          ? 'Ticket validé. La messagerie reste accessible à l’équipe support.'
          : 'Demande clôturée pour le client. Vous pouvez toujours lui répondre depuis la Messagerie support.',
      });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de mettre à jour ce ticket' });
      await loadSupportTickets();
      if (status !== 'in_progress') {
        navigate('/admin/messenger', { state: { supportTicket: { source, id } } });
      }
    } finally {
      setProcessingTicketId(null);
    }
  };

  const handleArchiveSupportTicket = async (ticket: Record<string, unknown>) => {
    const id = String(ticket.id);
    const source = ticket.source === 'contact' ? 'contact' : 'support';
    if (!window.confirm('Archiver cette demande ? Son historique sera conservé et pourra être restauré.')) return;
    setProcessingTicketId(`${source}:${id}`);
    setBanner(null);
    try {
      await apiFetch(`/api/admin/support/${source}/${id}`, { method: 'DELETE' });
      if (await loadSupportTickets()) {
        setBanner({ tone: 'success', text: 'Demande archivée. Son historique est conservé dans la Messagerie.' });
      }
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’archiver cette demande' });
    } finally {
      setProcessingTicketId(null);
    }
  };

  const handleDeleteAuditLog = async (id: string) => {
    setDeletingAuditLog(id);
    try {
      await apiFetch(`/api/admin/audit-logs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadAdminData();
      setBanner({ tone: 'success', text: 'Entrée supprimée. La suppression a été enregistrée dans le journal.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de supprimer cette entrée' });
    } finally {
      setDeletingAuditLog(null);
    }
  };

  const handleClearAuditLogs = async () => {
    setClearingAuditLogs(true);
    try {
      await apiFetch('/api/admin/audit-logs', { method: 'DELETE' });
      await loadAdminData();
      setBanner({ tone: 'success', text: 'Journal vidé. La suppression a été enregistrée dans le journal.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de vider le journal' });
    } finally {
      setClearingAuditLogs(false);
    }
  };

  useEffect(() => {
    loadAdminData();
  }, [userSearch, canDeleteUsers, usersLastSeenAt]);

  useEffect(() => {
    if (activeTab !== 'support') return;
    let active = true;
    const refreshTickets = async () => {
      try {
        const { tickets } = await apiFetch<{ tickets: Array<Record<string, unknown>> }>('/api/admin/support');
        if (active) {
          setContent((currentContent) => currentContent ? { ...currentContent, tickets } : currentContent);
        }
      } catch (err) {
        if (active) {
          setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’actualiser les tickets support' });
        }
      }
    };
    void refreshTickets();
    const interval = window.setInterval(refreshTickets, 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeTab]);

  useEffect(() => {
    let active = true;
    const interval = window.setInterval(async () => {
      try {
        const latestOverview = await apiFetch<Record<string, number>>(
          `/api/admin/overview?usersSince=${encodeURIComponent(usersLastSeenAt)}`
        );
        if (active) setOverview(latestOverview);
      } catch (err) {
        if (active) {
          setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’actualiser les notifications' });
        }
      }
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [usersLastSeenAt]);

  useEffect(() => {
    const storedTimestamp = window.localStorage.getItem(ADMIN_USERS_LAST_SEEN_KEY);
    const timestamp = activeTab === 'users' || !storedTimestamp
      ? new Date().toISOString()
      : storedTimestamp;
    if (activeTab === 'users' || !storedTimestamp) {
      window.localStorage.setItem(ADMIN_USERS_LAST_SEEN_KEY, timestamp);
    }
    setUsersLastSeenAt(timestamp);
  }, [activeTab]);

  const handleSaveGlobalSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    setSavingGlobal(true);
    try {
      await apiFetch('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ key: 'main_number', value: mainNumberInput.trim() }),
      });
      await apiFetch('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ key: 'free_offer_enabled', value: freeOfferInput }),
      });
      await Promise.all([refreshPlatformConfig(), loadAdminData()]);
      setBanner({
        tone: 'success',
        text: `Paramètres globaux enregistrés : Main Number (${mainNumberInput.trim()}) et Offre Gratuite (${freeOfferInput ? '0,00 € active' : 'désactivée'}).`,
      });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Échec de l’enregistrement des paramètres centraux' });
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleSaveExpertPresence = async (
    expertId: string,
    presenceStatus: 'online' | 'busy' | 'offline'
  ) => {
    setBanner(null);
    setSavingExpertPresenceId(expertId);
    try {
      await apiFetch(`/api/admin/experts/${expertId}`, {
        method: 'PATCH',
        body: JSON.stringify({ presenceStatus }),
      });
      setExperts((current) =>
        current.map((expert) => expert.id === expertId ? { ...expert, presence_status: presenceStatus } : expert)
      );
      setBanner({
        tone: 'success',
        text: `Mode de disponibilité mis à jour : ${presenceStatus === 'online' ? 'En ligne' : presenceStatus === 'busy' ? 'En séance' : 'Sur RDV'}.`,
      });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de modifier le mode de disponibilité.' });
    } finally {
      setSavingExpertPresenceId(null);
    }
  };

  const handleSaveHomepageStats = async (e: React.FormEvent) => {
    e.preventDefault();
    const values = Object.values(homepageStatsInput);
    if (values.some((value) => {
      if (!value.trim()) return false;
      const count = Number(value);
      return !Number.isInteger(count) || count < 0 || count > 2_147_483_647;
    })) {
      setBanner({ tone: 'error', text: 'Saisissez des nombres entiers positifs ou laissez les champs vides pour utiliser les chiffres réels.' });
      return;
    }

    setBanner(null);
    setSavingHomepageStats(true);
    try {
      await apiFetch('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          key: 'homepage_stats',
          value: {
            verifiedExperts: homepageStatsInput.verifiedExperts.trim() ? Number(homepageStatsInput.verifiedExperts) : null,
            completedConsultations: homepageStatsInput.completedConsultations.trim() ? Number(homepageStatsInput.completedConsultations) : null,
            publishedReviews: homepageStatsInput.publishedReviews.trim() ? Number(homepageStatsInput.publishedReviews) : null,
          },
        }),
      });
      await loadAdminData();
      setBanner({ tone: 'success', text: 'Les chiffres clés de la page d’accueil ont été enregistrés.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’enregistrer les chiffres de la page d’accueil.' });
    } finally {
      setSavingHomepageStats(false);
    }
  };

  const handleSaveExpertLink = async (expertId: string) => {
    const externalChatUrl = expertExternalLinks[expertId]?.trim() || null;
    setBanner(null);
    setSavingExpertLink(expertId);
    try {
      await apiFetch(`/api/admin/experts/${expertId}`, {
        method: 'PATCH',
        body: JSON.stringify({ externalChatUrl }),
      });
      setExperts((current) =>
        current.map((expert) => expert.id === expertId ? { ...expert, external_chat_url: externalChatUrl } : expert)
      );
      setBanner({ tone: 'success', text: 'Lien externe du conseiller enregistré.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’enregistrer le lien externe' });
    } finally {
      setSavingExpertLink(null);
    }
  };

  const handleSaveExpertProfile = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingExpertProfile) return;

    const languages = editingExpertProfile.languages.split(',').map((language) => language.trim()).filter(Boolean);
    if (languages.length === 0) {
      setBanner({ tone: 'error', text: 'Indiquez au moins une langue parlée.' });
      return;
    }

    setBanner(null);
    setSavingExpertProfile(true);
    try {
      await apiFetch(`/api/admin/experts/${editingExpertProfile.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: editingExpertProfile.displayName,
          headline: editingExpertProfile.headline,
          specialty: editingExpertProfile.specialty,
          biography: editingExpertProfile.biography,
          yearsExperience: Number(editingExpertProfile.yearsExperience),
          completedConsultations: Number(editingExpertProfile.completedConsultations),
          languages,
        }),
      });
      await loadAdminData();
      setEditingExpertProfile(null);
      setBanner({ tone: 'success', text: 'Profil du conseiller enregistré.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’enregistrer le profil du conseiller' });
    } finally {
      setSavingExpertProfile(false);
    }
  };

  const handleToggleExpertStatus = async (expert: Record<string, unknown>) => {
    const nextStatus = expert.status === 'approved' ? 'suspended' : 'approved';
    setBanner(null);
    try {
      await apiFetch(`/api/admin/experts/${expert.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadAdminData();
      setBanner({
        tone: 'success',
        text: nextStatus === 'approved'
          ? 'Conseiller approuvé : son compte est activé et son profil est visible.'
          : 'Conseiller suspendu : son profil est masqué et son compte est désactivé.',
      });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de modifier le statut du conseiller' });
    }
  };

  const handleSaveExpertReviewStats = async (expertId: string) => {
    const values = expertReviewStats[expertId];
    const rating = Number(values?.rating);
    const count = Number(values?.count);
    if (!values || !Number.isFinite(rating) || rating < 0 || rating > 5 || !Number.isInteger(count) || count < 0 || count > 2_147_483_647) {
      setBanner({ tone: 'error', text: 'Saisissez une note entre 0 et 5 et un nombre d’avis entier positif.' });
      return;
    }

    setBanner(null);
    setSavingReviewStatsId(expertId);
    try {
      await apiFetch(`/api/admin/experts/${expertId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ratingOverrideBp: Math.round(rating * 100),
          reviewCountOverride: count,
        }),
      });
      await loadAdminData();
      setBanner({ tone: 'success', text: 'Les chiffres d’avis du conseiller ont été enregistrés.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’enregistrer ces chiffres.' });
    } finally {
      setSavingReviewStatsId(null);
    }
  };

  const handleResetExpertReviewStats = async (expertId: string) => {
    setBanner(null);
    setSavingReviewStatsId(expertId);
    try {
      await apiFetch(`/api/admin/experts/${expertId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ratingOverrideBp: null, reviewCountOverride: null }),
      });
      await loadAdminData();
      setBanner({ tone: 'success', text: 'Les chiffres sont de nouveau calculés à partir des avis publiés.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de rétablir les chiffres calculés.' });
    } finally {
      setSavingReviewStatsId(null);
    }
  };

  const handleCreateExpert = async () => {
    const displayName = newExpertForm.displayName.trim();
    const specialty = newExpertForm.specialty.trim() || 'Tarot';
    if (!displayName) {
      setBanner({ tone: 'error', text: 'Le nom du conseiller est obligatoire.' });
      return;
    }

    setBanner(null);
    setCreatingExpert(true);
    try {
      const credentials = await apiFetch<{ email: string; temporaryPassword: string }>('/api/admin/experts', {
        method: 'POST',
        body: JSON.stringify({
          displayName,
          specialty,
          status: newExpertForm.status,
          presenceStatus: newExpertForm.presenceStatus,
        }),
      });
      setNewExpertForm({ displayName: '', specialty: 'Tarot', status: 'suspended', presenceStatus: 'offline' });
      await loadAdminData();
      setBanner({
        tone: 'success',
        text: `Conseiller ajouté. Identifiants à transmettre : ${credentials.email} · Mot de passe temporaire : ${credentials.temporaryPassword}`,
      });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible d’ajouter ce conseiller.' });
    } finally {
      setCreatingExpert(false);
    }
  };

  const handleDeleteExpert = async (expertId: string) => {
    setBanner(null);
    setRemovingExpertId(expertId);
    try {
      await apiFetch(`/api/admin/experts/${expertId}`, { method: 'DELETE' });
      const refreshed = await loadAdminData();
      setBanner(refreshed
        ? { tone: 'success', text: 'Le conseiller, son compte et ses données associées ont été définitivement supprimés.' }
        : { tone: 'error', text: 'Conseiller supprimé, mais impossible d’actualiser la liste.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de retirer ce conseiller.' });
    } finally {
      setRemovingExpertId(null);
    }
  };

  const handleDeleteUser = async (userId: string, email: string) => {
    if (!window.confirm(`Supprimer le compte ${email} ? Il ne pourra plus se connecter et sera retiré des listes publiques. L’historique associé sera conservé.`)) return;

    setBanner(null);
    setDeletingUserId(userId);
    try {
      await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      await loadAdminData();
      setBanner({ tone: 'success', text: 'Le compte utilisateur a été supprimé. Son historique a été conservé.' });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de supprimer cet utilisateur.' });
    } finally {
      setDeletingUserId(null);
    }
  };

  const handleToggleUserStatus = async (userId: string, currentStatus: string) => {
    const nextStatus = currentStatus === 'active' ? 'suspended' : 'active';
    setBanner(null);
    setUpdatingUserId(userId);
    try {
      await apiFetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setUsers((currentUsers) => currentUsers.map((currentUser) => (
        String(currentUser.id) === userId
          ? { ...currentUser, status: nextStatus }
          : currentUser
      )));
      setBanner({
        tone: 'success',
        text: nextStatus === 'active' ? 'Le compte a été réactivé.' : 'Le compte a été suspendu.',
      });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de modifier le statut du compte.' });
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleDeleteApplication = async (applicationId: string, displayName: string, alreadyRejected: boolean) => {
    const confirmation = alreadyRejected
      ? `Supprimer définitivement la candidature refusée de ${displayName} ? Cette action est irréversible.`
      : `Refuser la candidature de ${displayName} et supprimer définitivement toutes ses données ? Cette action est irréversible.`;
    if (!window.confirm(confirmation)) return;

    setBanner(null);
    setDeletingApplicationId(applicationId);
    try {
      await apiFetch(`/api/admin/applications/${applicationId}`, { method: 'DELETE' });
      await loadAdminData();
      setBanner({
        tone: 'success',
        text: alreadyRejected
          ? 'La candidature refusée a été définitivement supprimée.'
          : 'La candidature a été refusée et définitivement supprimée.',
      });
    } catch (err) {
      setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de supprimer cette candidature.' });
    } finally {
      setDeletingApplicationId(null);
    }
  };

  const navItems: NavItem[] = [
    { id: 'experts', label: 'Conseillers', icon: <UserCheck className="h-4 w-4" /> },
    ...(canDeleteUsers ? [{
      id: 'applications',
      label: 'Données Devenir Conseiller',
      icon: <FileText className="h-4 w-4" />,
      badge: overview?.pendingApplications,
      badgeStyle: 'notification' as const,
    } satisfies NavItem] : []),
    {
      id: 'users',
      label: 'Utilisateurs & Rôles',
      icon: <Users className="h-4 w-4" />,
      badge: overview?.newUsers,
      badgeStyle: 'notification',
    },
    {
      id: 'messenger',
      label: 'Assistance clients',
      icon: <LifeBuoy className="h-4 w-4" />,
      badge: overview?.unreadSupportMessages,
      badgeStyle: 'notification',
    },
    { id: 'content', label: 'Paramètres & Éditorial', icon: <PhoneCall className="h-4 w-4" /> },
    { id: 'audit', label: 'Journaux d’Audit', icon: <ShieldAlert className="h-4 w-4" /> },
  ];

  const handleExportLedgerCsv = () => {
    const rows = financials?.ledger || [];
    const header = 'id,email,type,amount_cents,balance_after_cents,description,created_at\n';
    const body = rows
      .map((r) => `${r.id},${r.email},${r.type},${r.amount_cents},${r.balance_after_cents},"${String(r.description).replace(/"/g, '""')}",${r.created_at}`)
      .join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'astralis-grand-livre-financier.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const reviewableExperts = experts.filter(
    (expert) => expert.status === 'approved' && expert.user_status === 'active'
  );

  return (
    <DashboardShell
      portalTitle="Espace d’administration"
      subtitle="Gouvernance, Paramètres Centraux & Finance"
      navItems={navItems}
      activeTab={activeTab}
      onSelectTab={setTab}
      headerActions={
        <div className="flex items-center gap-3 text-xs">
          <span className="hidden md:inline font-mono text-[#64667A]">
            Main Number : <strong className="text-[#101323]">{mainNumber}</strong>
          </span>
          <Button size="sm" variant="outline" onClick={() => setTab('content')}>
            Modifier Main Number
          </Button>
        </div>
      }
    >
      <div className="space-y-6 w-full">
        {banner && (
          <div
            className="fixed right-4 top-24 z-40 w-[calc(100vw-2rem)] max-w-md shadow-lg"
            role={banner.tone === 'error' ? 'alert' : 'status'}
            aria-live={banner.tone === 'error' ? 'assertive' : 'polite'}
          >
            <div className="relative">
              <AlertBanner tone={banner.tone}>
                <div className="pr-5">{banner.text}</div>
              </AlertBanner>
              <button
                type="button"
                onClick={() => setBanner(null)}
                aria-label="Fermer la notification"
                className="absolute right-2 top-2 rounded p-1 opacity-70 hover:bg-black/5 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* CANDIDATURES */}
        {activeTab === 'applications' && (
          <div className="space-y-4">
            <div>
              <h2 className="font-serif text-2xl font-medium text-[#101323]">Données Devenir Conseiller</h2>
              <p className="mt-1 text-sm text-[#64667A]">Consultez toutes les informations transmises dans le formulaire public de candidature.</p>
            </div>
            {applications.length === 0 && (
              <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 text-sm text-[#64667A]">
                Aucune candidature reçue pour le moment.
              </div>
            )}
            {applications.map((app) => {
              const applicationId = String(app.id);
              const displayName = String(app.display_name || app.full_name);
              const status = String(app.status);
              const alreadyRejected = status === 'rejected';
              const canReview = !alreadyRejected && status !== 'approved' && status !== 'activated';
              const portfolioUrl = getSafeExternalUrl(app.portfolio_url);
              return (
              <div key={String(app.id)} className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="font-serif text-2xl font-medium text-[#101323]">
                      {String(app.display_name)} ({String(app.full_name)})
                    </div>
                    <div className="text-xs text-[#64667A]">
                      Candidature du {formatDate(String(app.created_at))} · {STATUS_FR[String(app.status)] || String(app.status)}
                    </div>
                  </div>
                  {(canReview || alreadyRejected) && (
                    <div className="flex flex-wrap gap-2">
                      {canReview && (
                        <Button
                          size="sm"
                          disabled={deletingApplicationId === applicationId}
                          onClick={async () => {
                            try {
                              await apiFetch(`/api/admin/applications/${applicationId}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ status: 'approved' }),
                              });
                              setTab('experts');
                              await loadAdminData();
                              setBanner({
                                tone: 'success',
                                text: 'Candidature validée. Le conseiller est suspendu : modifiez son profil, puis approuvez-le pour activer son compte.',
                              });
                            } catch (err) {
                              setBanner({ tone: 'error', text: err instanceof Error ? err.message : 'Impossible de valider la candidature' });
                            }
                          }}
                        >
                          Valider la candidature
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={deletingApplicationId === applicationId}
                        onClick={() => handleDeleteApplication(applicationId, displayName, alreadyRejected)}
                      >
                        {deletingApplicationId === applicationId
                          ? 'Suppression...'
                          : alreadyRejected ? 'Supprimer définitivement' : 'Refuser'}
                      </Button>
                    </div>
                  )}
                </div>
                <dl className="grid grid-cols-1 gap-3 border-t border-[#25263A]/10 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div><dt className="text-xs text-[#64667A]">Adresse e-mail</dt><dd className="break-all font-medium">{String(app.email || '—')}</dd></div>
                  <div><dt className="text-xs text-[#64667A]">Téléphone</dt><dd className="font-medium">{String(app.phone || '—')}</dd></div>
                  <div><dt className="text-xs text-[#64667A]">Pays d’exercice</dt><dd className="font-medium">{String(app.country || '—')}</dd></div>
                  <div><dt className="text-xs text-[#64667A]">Années d’expérience</dt><dd className="font-medium">{String(app.years_experience ?? '—')}</dd></div>
                  <div><dt className="text-xs text-[#64667A]">Langues parlées</dt><dd className="font-medium">{formatApplicationList(app.languages_json, APPLICATION_LANGUAGE_LABELS)}</dd></div>
                  <div><dt className="text-xs text-[#64667A]">Disciplines principales</dt><dd className="font-medium">{formatApplicationList(app.specialties_json)}</dd></div>
                  <div><dt className="text-xs text-[#64667A]">Modes de consultation</dt><dd className="font-medium">{formatApplicationList(app.methods_json, APPLICATION_METHOD_LABELS)}</dd></div>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <dt className="text-xs text-[#64667A]">Portfolio, publications ou CV</dt>
                    <dd className="break-all font-medium">
                      {portfolioUrl ? (
                        <a href={portfolioUrl} target="_blank" rel="noopener noreferrer" className="text-[#101323] underline hover:text-[#B49154]">
                          {String(app.portfolio_url)}
                        </a>
                      ) : String(app.portfolio_url || '—')}
                    </dd>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <dt className="text-xs text-[#64667A]">Biographie professionnelle et méthodologie</dt>
                    <dd className="mt-1 whitespace-pre-wrap text-[#25263A]">{String(app.biography || '—')}</dd>
                  </div>
                </dl>
                {typeof app.internal_notes === 'string' && app.internal_notes.length > 0 && (
                  <div className="rounded bg-[#F7F4EF] p-3 text-xs text-[#64667A]">
                    <span className="font-semibold text-[#101323]">Note interne :</span> {app.internal_notes}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}

        {activeTab === 'experts' && (
          <div className="flex flex-wrap gap-2 border-b border-[#25263A]/10 pb-2" role="tablist" aria-label="Sections conseillers">
            <button
              type="button"
              role="tab"
              aria-selected={expertSection === 'directory'}
              onClick={() => navigate('/admin/experts')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                expertSection === 'directory'
                  ? 'bg-[#101323] text-[#F7F4EF]'
                  : 'text-[#64667A] hover:bg-[#25263A]/5'
              }`}
            >
              Conseillers
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={expertSection === 'reviews'}
              onClick={() => navigate('/admin/experts/reviews')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                expertSection === 'reviews'
                  ? 'bg-[#101323] text-[#F7F4EF]'
                  : 'text-[#64667A] hover:bg-[#25263A]/5'
              }`}
            >
              Avis Clients
            </button>
          </div>
        )}

        {/* CONSEILLERS */}
        {activeTab === 'experts' && expertSection === 'directory' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-[#25263A]/10 bg-white p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="flex-1">
                  <Input
                    label="Nom du conseiller"
                    value={newExpertForm.displayName}
                    onChange={(event) => setNewExpertForm((current) => ({ ...current, displayName: event.target.value }))}
                    placeholder="Ex. Liora Morel"
                  />
                </div>
                <div className="flex-1">
                  <Input
                    label="Spécialité"
                    value={newExpertForm.specialty}
                    onChange={(event) => setNewExpertForm((current) => ({ ...current, specialty: event.target.value }))}
                    placeholder="Tarot"
                  />
                </div>
                <div className="w-full lg:w-44">
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-[#64667A]">Statut</label>
                  <select
                    value={newExpertForm.status}
                    onChange={(event) =>
                      setNewExpertForm((current) => ({
                        ...current,
                        status: event.target.value as 'approved' | 'pending' | 'suspended' | 'rejected',
                      }))
                    }
                    className="w-full min-h-[42px] rounded-md border border-[#25263A]/20 bg-white px-3.5 py-2 text-sm text-[#25263A] focus:border-[#C7A66A] focus:outline-none"
                  >
                    <option value="approved">Approuvé</option>
                    <option value="pending">En attente</option>
                    <option value="suspended">Suspendu</option>
                    <option value="rejected">Rejeté</option>
                  </select>
                </div>
                <div className="w-full lg:w-48">
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-[#64667A]">Mode de disponibilité</label>
                  <select
                    value={newExpertForm.presenceStatus}
                    onChange={(event) =>
                      setNewExpertForm((current) => ({
                        ...current,
                        presenceStatus: event.target.value as 'online' | 'offline',
                      }))
                    }
                    className="w-full min-h-[42px] rounded-md border border-[#25263A]/20 bg-white px-3.5 py-2 text-sm text-[#25263A] focus:border-[#C7A66A] focus:outline-none"
                  >
                    <option value="offline">Sur RDV</option>
                    <option value="online">En ligne</option>
                  </select>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-4">
                <p className="text-xs text-[#64667A]">
                  Créé suspendu par défaut. Le mode choisi s’appliquera après approbation.
                </p>
                <Button size="sm" onClick={handleCreateExpert} disabled={creatingExpert}>
                  {creatingExpert ? 'Ajout...' : 'Ajouter un conseiller'}
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-[#25263A]/10 bg-white overflow-x-auto">
              <table className="w-full min-w-[1100px] text-start text-sm">
                <thead className="whitespace-nowrap bg-[#F7F4EF]/60 border-b border-[#25263A]/10 text-xs text-[#64667A]">
                <tr>
                  <th className="px-5 py-3 text-start">Conseiller</th>
                  <th className="px-5 py-3 text-start">Photo de profil</th>
                  <th className="px-5 py-3 text-start">Spécialité</th>
                  <th className="px-5 py-3 text-start">Statut</th>
                  <th className="px-5 py-3 text-start">Disponibilité</th>
                  <th className="px-5 py-3 text-start">Lien externe du tchat</th>
                  <th className="min-w-[140px] px-3 py-3 text-start">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#25263A]/10">
                {experts.map((ex) => (
                  <tr key={String(ex.id)}>
                    <td className="px-5 py-3.5 font-medium">{String(ex.display_name)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        {typeof ex.avatar_url === 'string' && ex.avatar_url ? (
                          <img
                            src={ex.avatar_url}
                            alt={`Photo de ${String(ex.display_name)}`}
                            className="h-14 w-[42px] rounded object-cover"
                          />
                        ) : (
                          <div className="flex h-14 w-[42px] items-center justify-center rounded bg-[#191E32] text-center text-[9px] text-[#C7A66A]">
                            Image par défaut
                          </div>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setAvatarExpert(ex)}>
                          <ImagePlus className="h-3.5 w-3.5" />
                          Modifier
                        </Button>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-[#64667A]">{String(ex.specialty)}</td>
                    <td className="px-5 py-3.5 text-xs uppercase">
                      <span className={
                        ex.status === 'approved'
                          ? 'font-medium text-[#166534]'
                          : ex.status === 'suspended'
                            ? 'font-medium text-[#B91C1C]'
                            : ''
                      }>
                        {STATUS_FR[String(ex.status)] || String(ex.status)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <select
                        aria-label={`Mode de disponibilité pour ${String(ex.display_name)}`}
                        value={String(ex.presence_status || 'offline')}
                        onChange={(event) =>
                          void handleSaveExpertPresence(
                            String(ex.id),
                            event.target.value as 'online' | 'busy' | 'offline'
                          )
                        }
                        disabled={savingExpertPresenceId === String(ex.id)}
                        className="min-h-[38px] rounded-md border border-[#25263A]/20 bg-white px-2.5 py-1.5 text-xs text-[#25263A] focus:border-[#C7A66A] focus:outline-none disabled:opacity-50"
                      >
                        <option value="online">En ligne</option>
                        <option value="offline">Sur RDV</option>
                        <option value="busy">En séance</option>
                      </select>
                      {ex.status !== 'approved' && (
                        <div className="mt-1 text-[10px] text-[#64667A]">Après approbation</div>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex min-w-[260px] gap-2">
                        <Input
                          aria-label={`Lien externe du tchat pour ${String(ex.display_name)}`}
                          type="url"
                          placeholder="https://..."
                          value={expertExternalLinks[String(ex.id)] || ''}
                          onChange={(event) =>
                            setExpertExternalLinks((current) => ({ ...current, [String(ex.id)]: event.target.value }))
                          }
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={savingExpertLink === String(ex.id)}
                          onClick={() => handleSaveExpertLink(String(ex.id))}
                        >
                          {savingExpertLink === String(ex.id) ? 'Enregistrement...' : 'Enregistrer'}
                        </Button>
                      </div>
                    </td>
                    <td className="min-w-[140px] px-3 py-3.5">
                      <div className="flex flex-col gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditingExpertProfile({
                            id: String(ex.id),
                            displayName: String(ex.display_name || ''),
                            headline: String(ex.headline || ''),
                            specialty: String(ex.specialty || ''),
                            biography: String(ex.biography || ''),
                            yearsExperience: String(ex.years_experience ?? 0),
                            completedConsultations: String(ex.completed_consultations ?? 0),
                            languages: parseStringArray(ex.languages_json).join(', '),
                          })}
                          className="w-full rounded px-1.5 py-1 text-start text-xs font-medium text-[#101323] hover:bg-[#F7F4EF] hover:underline"
                        >
                          Modifier le profil
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await apiFetch(`/api/admin/experts/${ex.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ isFeatured: !ex.is_featured }),
                            });
                            loadAdminData();
                          }}
                          className="w-full rounded px-1.5 py-1 text-start text-xs font-medium text-[#B49154] hover:bg-[#F7F4EF] hover:underline"
                        >
                          {ex.is_featured ? 'Retirer de la une' : 'Mettre en avant'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleExpertStatus(ex)}
                          className="w-full rounded px-1.5 py-1 text-start text-xs font-medium text-[#101323] hover:bg-[#F7F4EF] hover:underline"
                        >
                          {ex.status === 'approved' ? 'Suspendre' : 'Approuver'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteExpert(String(ex.id))}
                          disabled={removingExpertId === String(ex.id)}
                          title="Supprimer définitivement le profil, le compte et les données associées"
                          aria-label={`Supprimer définitivement ${String(ex.display_name)} et ses données associées`}
                          className="w-full rounded px-1.5 py-1 text-start text-xs font-medium text-[#B91C1C] hover:bg-[#F7F4EF] hover:underline disabled:opacity-50"
                        >
                          {removingExpertId === String(ex.id) ? 'Suppression...' : 'Supprimer'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        )}

        {/* UTILISATEURS */}
        {activeTab === 'users' && (
          <div className="space-y-4">
            <Input label="Rechercher un utilisateur par nom, e-mail ou téléphone" value={userSearch} onChange={(e) => setUserSearch(e.target.value)} />
            <div className="rounded-lg border border-[#25263A]/10 bg-white overflow-x-auto">
              <table className="w-full min-w-[900px] text-start text-sm">
                <thead className="whitespace-nowrap bg-[#F7F4EF]/60 border-b border-[#25263A]/10 text-xs text-[#64667A]">
                  <tr>
                    <th className="px-5 py-3 text-start">Adresse E-mail</th>
                    <th className="px-5 py-3 text-start">Nom et prénom</th>
                    <th className="px-5 py-3 text-start">Rôles</th>
                    <th className="px-5 py-3 text-start">Statut</th>
                    <th className="px-5 py-3 text-start">Téléphone</th>
                    <th className="px-5 py-3 text-end">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#25263A]/10">
                  {users.map((u) => (
                    <tr key={String(u.id)}>
                      <td className="px-5 py-3.5 font-medium">{String(u.email)}</td>
                      <td className="px-5 py-3.5">
                        {[u.first_name, u.last_name]
                          .map((name) => typeof name === 'string' ? name.trim() : '')
                          .filter(Boolean)
                          .join(' ') || '—'}
                      </td>
                      <td className="px-5 py-3.5 text-xs">{String(u.roles_csv || 'client')}</td>
                      <td className="px-5 py-3.5 text-xs uppercase">
                        <span className={
                          u.status === 'active'
                            ? 'font-medium text-[#166534]'
                            : u.status === 'suspended'
                              ? 'font-medium text-[#B91C1C]'
                              : ''
                        }>
                          {STATUS_FR[String(u.status)] || String(u.status)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">{String(u.phone || '—')}</td>
                      <td className="px-5 py-3.5 text-end">
                        {String(u.id) !== user?.id && (
                          <button
                            type="button"
                            onClick={() => handleToggleUserStatus(String(u.id), String(u.status))}
                            disabled={updatingUserId === String(u.id)}
                            aria-busy={updatingUserId === String(u.id)}
                            className="inline-flex min-w-[5.5rem] justify-center text-xs font-medium text-[#101323] hover:underline disabled:opacity-50"
                          >
                            {u.status === 'active' ? 'Suspendre' : 'Réactiver'}
                          </button>
                        )}
                        {canDeleteUsers && u.id !== user?.id && !String(u.roles_csv || '').split(',').includes('admin') && (
                          <button
                            type="button"
                            onClick={() => handleDeleteUser(String(u.id), String(u.email))}
                            disabled={deletingUserId === String(u.id)}
                            className="ms-3 text-xs font-medium text-[#B91C1C] hover:underline disabled:opacity-50"
                          >
                            {deletingUserId === String(u.id) ? 'Suppression...' : 'Supprimer'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CONSULTATIONS */}
        {activeTab === 'consultations' && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white overflow-x-auto">
            <table className="w-full min-w-[900px] text-start text-sm">
              <thead className="whitespace-nowrap bg-[#F7F4EF]/60 border-b border-[#25263A]/10 text-xs text-[#64667A]">
                <tr>
                  <th className="px-5 py-3 text-start">Client</th>
                  <th className="px-5 py-3 text-start">Conseiller</th>
                  <th className="px-5 py-3 text-start">Facturation</th>
                  <th className="px-5 py-3 text-start">Statut</th>
                  <th className="px-5 py-3 text-end">Brut</th>
                  <th className="px-5 py-3 text-end">Commission</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#25263A]/10">
                {consultations.map((c) => (
                  <tr key={String(c.id)}>
                    <td className="px-5 py-3">{String(c.client_name)}</td>
                    <td className="px-5 py-3">{String(c.expert_name)}</td>
                    <td className="px-5 py-3 text-xs">{String(c.billing_model)}</td>
                    <td className="px-5 py-3 text-xs uppercase">{STATUS_FR[String(c.status)] || String(c.status)}</td>
                    <td className="px-5 py-3 text-end font-mono tabular-nums">{formatCurrency(Number(c.gross_amount_cents))}</td>
                    <td className="px-5 py-3 text-end font-mono tabular-nums">{formatCurrency(Number(c.commission_cents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* FINANCES */}
        {activeTab === 'financials' && financials && (
          <div className="space-y-6">
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={handleExportLedgerCsv}>
                Exporter le Grand Livre CSV
              </Button>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-3">
                <h2 className="font-serif text-2xl text-[#101323]">Demandes de Retrait</h2>
                {financials.withdrawals.map((w) => (
                  <div key={String(w.id)} className="flex items-center justify-between border-t border-[#25263A]/10 pt-3 text-sm">
                    <div>
                      <div className="font-medium">{String(w.expert_name)}</div>
                      <div className="text-xs text-[#64667A]">
                        {String(w.payout_method)} · {STATUS_FR[String(w.status)] || String(w.status)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono tabular-nums">{formatCurrency(Number(w.amount_cents))}</span>
                      {w.status === 'pending' && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            await apiFetch(`/api/admin/withdrawals/${w.id}/process`, { method: 'POST', body: JSON.stringify({ decision: 'paid' }) });
                            loadAdminData();
                          }}
                        >
                          Marquer Payé
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-3">
                <h2 className="font-serif text-2xl text-[#101323]">Demandes de Remboursement</h2>
                {financials.refunds.length === 0 ? (
                  <p className="text-xs text-[#64667A]">Aucune demande de remboursement en attente.</p>
                ) : (
                  financials.refunds.map((r) => (
                    <div key={String(r.id)} className="flex items-center justify-between border-t border-[#25263A]/10 pt-3 text-sm">
                      <div>
                        <div className="font-medium">{String(r.email)}</div>
                        <div className="text-xs text-[#64667A]">
                          {String(r.reason)} · {STATUS_FR[String(r.status)] || String(r.status)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono tabular-nums">{formatCurrency(Number(r.amount_cents))}</span>
                        {r.status === 'requested' && (
                          <Button
                            size="sm"
                            onClick={async () => {
                              await apiFetch(`/api/admin/refunds/${r.id}/process`, { method: 'POST', body: JSON.stringify({ decision: 'processed' }) });
                              loadAdminData();
                            }}
                          >
                            Approuver
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* COMMISSIONS */}
        {activeTab === 'commissions' && financials && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await apiFetch('/api/admin/commissions', {
                  method: 'POST',
                  body: JSON.stringify({ scope: newRuleScope, rateBp: Math.round(Number(newRuleRatePct) * 100), description: newRuleDesc }),
                });
                setNewRuleDesc('');
                loadAdminData();
                setBanner({ tone: 'success', text: 'Règle de commission créée.' });
              }}
              className="lg:col-span-5 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4"
            >
              <h2 className="font-serif text-2xl text-[#101323]">Ajouter une Règle de Commission</h2>
              <Select label="Portée" value={newRuleScope} onChange={(e) => setNewRuleScope(e.target.value)}>
                <option value="global">Défaut Global</option>
                <option value="service_type">Par Type de Service</option>
                <option value="promotional">Promotionnelle</option>
              </Select>
              <Input label="Taux de Commission (%)" type="number" step="0.5" value={newRuleRatePct} onChange={(e) => setNewRuleRatePct(e.target.value)} />
              <Input label="Description" required value={newRuleDesc} onChange={(e) => setNewRuleDesc(e.target.value)} />
              <Button type="submit">Créer la Règle</Button>
            </form>

            <div className="lg:col-span-7 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-3">
              <h2 className="font-serif text-2xl text-[#101323]">Règles de Commission Actives</h2>
              {financials.commissionRules.map((cr) => (
                <div key={String(cr.id)} className="flex items-center justify-between border-t border-[#25263A]/10 pt-3 text-sm">
                  <div>
                    <div className="font-medium">{String(cr.description)}</div>
                    <div className="text-xs text-[#64667A]">Portée : {String(cr.scope)}</div>
                  </div>
                  <span className="font-mono font-semibold tabular-nums">{Number(cr.rate_bp) / 100}%</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* COUPONS */}
        {activeTab === 'rewards' && content && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await apiFetch('/api/admin/coupons', {
                  method: 'POST',
                  body: JSON.stringify({ code: newCouponCode, discountType: 'fixed_cents', discountValue: Number(newCouponValue), pointsCost: 500 }),
                });
                setNewCouponCode('');
                loadAdminData();
                setBanner({ tone: 'success', text: 'Code promotionnel créé.' });
              }}
              className="lg:col-span-5 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4"
            >
              <h2 className="font-serif text-2xl text-[#101323]">Créer un Code Promotionnel</h2>
              <Input label="Code" required value={newCouponCode} onChange={(e) => setNewCouponCode(e.target.value)} placeholder="EQUINOXE15" />
              <Input label="Valeur de Réduction (centimes)" type="number" required value={newCouponValue} onChange={(e) => setNewCouponValue(e.target.value)} />
              <Button type="submit">Créer le Code</Button>
            </form>

            <div className="lg:col-span-7 rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-3">
              <h2 className="font-serif text-2xl text-[#101323]">Codes Configurés</h2>
              {content.coupons.map((cp) => (
                <div key={String(cp.id)} className="flex justify-between border-t border-[#25263A]/10 pt-3 text-sm">
                  <span className="font-mono font-semibold">{String(cp.code)}</span>
                  <span className="text-xs text-[#64667A]">Utilisations : {String(cp.used_count)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AVIS */}
        {activeTab === 'experts' && expertSection === 'reviews' && (
          <div className="space-y-6">
            <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
              <div>
                <h2 className="font-serif text-2xl text-[#101323]">Chiffres d’avis par conseiller</h2>
                <p className="mt-1 text-xs text-[#64667A]">
                  Définissez la note moyenne et le nombre affichés sur chaque profil. Les avis individuels restent inchangés.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-start text-sm">
                  <thead className="whitespace-nowrap border-b border-[#25263A]/10 bg-[#F7F4EF]/60 text-xs text-[#64667A]">
                    <tr>
                      <th className="px-4 py-3 text-start">Conseiller</th>
                      <th className="px-4 py-3 text-start">Note moyenne / 5</th>
                      <th className="px-4 py-3 text-start">Nombre d’avis</th>
                      <th className="px-4 py-3 text-end">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#25263A]/10">
                    {reviewableExperts.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-6 text-center text-sm text-[#64667A]">
                          Aucun conseiller actif à afficher.
                        </td>
                      </tr>
                    ) : reviewableExperts.map((expert) => {
                      const expertId = String(expert.id);
                      const values = expertReviewStats[expertId] || { rating: '0.00', count: '0' };
                      const saving = savingReviewStatsId === expertId;
                      return (
                        <tr key={expertId}>
                          <td className="px-4 py-3.5 font-medium">
                            {String(expert.display_name)}
                            <span className="ms-2 text-[10px] uppercase text-[#64667A]">
                              {STATUS_FR[String(expert.status)] || String(expert.status)}
                            </span>
                          </td>
                          <td className="w-44 px-4 py-3.5">
                            <Input
                              aria-label={`Note moyenne affichée pour ${String(expert.display_name)}`}
                              type="number"
                              min="0"
                              max="5"
                              step="0.01"
                              value={values.rating}
                              onChange={(event) =>
                                setExpertReviewStats((current) => ({
                                  ...current,
                                  [expertId]: { ...values, rating: event.target.value },
                                }))
                              }
                            />
                          </td>
                          <td className="w-44 px-4 py-3.5">
                            <Input
                              aria-label={`Nombre d’avis affiché pour ${String(expert.display_name)}`}
                              type="number"
                              min="0"
                              max="2147483647"
                              step="1"
                              value={values.count}
                              onChange={(event) =>
                                setExpertReviewStats((current) => ({
                                  ...current,
                                  [expertId]: { ...values, count: event.target.value },
                                }))
                              }
                            />
                          </td>
                          <td className="px-4 py-3.5 text-end">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                disabled={saving}
                                onClick={() => handleSaveExpertReviewStats(expertId)}
                              >
                                {saving ? 'Enregistrement...' : 'Enregistrer'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={saving}
                                onClick={() => handleResetExpertReviewStats(expertId)}
                              >
                                Recalculer
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* PARAMÈTRES CENTRAUX & CONTENU ÉDITORIAL */}
        {activeTab === 'content' && content && (
          <div className="space-y-6">
            {/* Configuration Centrale Globale : Main Number & Offre Gratuite */}
            <form
              onSubmit={handleSaveGlobalSettings}
              className="rounded-lg border-2 border-[#C7A66A]/60 bg-white p-6 md:p-8 space-y-5"
            >
              <div className="border-b border-[#25263A]/10 pb-4">
                <div className="text-xs font-semibold uppercase tracking-widest text-[#C7A66A]">
                  Configuration Centrale de la Plateforme
                </div>
                <h2 className="mt-1 font-serif text-2xl font-medium text-[#101323]">
                  Numéro Principal (Main Number) &amp; Offre Gratuite 0,00 €
                </h2>
                <p className="mt-1 text-xs text-[#64667A]">
                  Modifiez ce paramètre central en un seul clic pour mettre à jour instantanément le numéro d’appel de tous les conseillers disponibles en tchat direct, sans modifier chaque fiche individuellement.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 items-end">
                <Input
                  label="Main Number (Numéro Principal d’Appel Direct)"
                  required
                  value={mainNumberInput}
                  onChange={(e) => setMainNumberInput(e.target.value)}
                  placeholder="+33123456789"
                />

                <label className="flex items-center gap-3 rounded-md border border-[#25263A]/15 bg-[#F7F4EF] px-4 py-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={freeOfferInput}
                    onChange={(e) => setFreeOfferInput(e.target.checked)}
                    className="h-4 w-4 accent-[#15803D]"
                  />
                  <div>
                    <div className="text-sm font-semibold text-[#101323]">
                      Activer l’Offre Gratuite à 0,00 € pour tous les conseillers
                    </div>
                    <div className="text-xs text-[#64667A]">
                      Affiche l’ancien tarif barré avec « 0,00 € » lumineux en dessous tout en conservant les tarifs originaux en base.
                    </div>
                  </div>
                </label>
              </div>

              <div className="flex justify-end">
                <Button type="submit" disabled={savingGlobal}>
                  {savingGlobal ? 'Enregistrement en cours...' : 'Enregistrer les Paramètres Centraux'}
                </Button>
              </div>
            </form>

            <form
              onSubmit={handleSaveHomepageStats}
              className="rounded-lg border border-[#25263A]/10 bg-white p-6 md:p-8 space-y-5"
            >
              <div className="border-b border-[#25263A]/10 pb-4">
                <h2 className="font-serif text-2xl font-medium text-[#101323]">Chiffres clés de la page d’accueil</h2>
                <p className="mt-1 text-xs text-[#64667A]">
                  Remplacez les chiffres affichés sur la page d’accueil. Laissez un champ vide pour afficher le nombre réel calculé automatiquement.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                <Input
                  label="Conseillers vérifiés"
                  type="number"
                  min="0"
                  max="2147483647"
                  step="1"
                  value={homepageStatsInput.verifiedExperts}
                  onChange={(event) => setHomepageStatsInput((current) => ({ ...current, verifiedExperts: event.target.value }))}
                  placeholder="Automatique"
                />
                <Input
                  label="Séances enregistrées"
                  type="number"
                  min="0"
                  max="2147483647"
                  step="1"
                  value={homepageStatsInput.completedConsultations}
                  onChange={(event) => setHomepageStatsInput((current) => ({ ...current, completedConsultations: event.target.value }))}
                  placeholder="Automatique"
                />
                <Input
                  label="Avis vérifiés après séance"
                  type="number"
                  min="0"
                  max="2147483647"
                  step="1"
                  value={homepageStatsInput.publishedReviews}
                  onChange={(event) => setHomepageStatsInput((current) => ({ ...current, publishedReviews: event.target.value }))}
                  placeholder="Automatique"
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={savingHomepageStats}>
                  {savingHomepageStats ? 'Enregistrement en cours...' : 'Enregistrer les chiffres clés'}
                </Button>
              </div>
            </form>

          </div>
        )}

        {activeTab === 'messenger' && (
          <AdminSupportMessenger onRead={() => { void refreshAdminOverview(); }} />
        )}

        {/* SUPPORT */}
        {activeTab === 'support' && content && (
          <div className="rounded-lg border border-[#25263A]/10 bg-white p-6 space-y-4">
            <h2 className="font-serif text-2xl text-[#101323]">File des Tickets Support</h2>
            {content.tickets.map((t) => (
              <div key={String(t.id)} className="border-t border-[#25263A]/10 pt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="font-medium">
                    {String(t.subject)} — {String(t.contact_name || t.user_email)}
                  </span>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium uppercase text-white ${supportStatusBadgeClass(String(t.status))}`}>
                    {STATUS_FR[String(t.status)] || String(t.status)}
                  </span>
                </div>
                <div className="text-xs text-[#64667A]">
                  {String(t.user_email)} · {t.source === 'contact' ? 'Formulaire de contact' : 'Espace client'}
                </div>
                {typeof t.message === 'string' && (
                  <p className="whitespace-pre-wrap rounded-md bg-[#F7F4EF] p-3">{t.message}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={processingTicketId === `${t.source}:${t.id}` || t.status === 'in_progress'}
                    onClick={() => void handleSupportStatus(t, 'in_progress')}
                  >
                    {processingTicketId === `${t.source}:${t.id}` ? 'Mise à jour...' : 'En cours'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={processingTicketId === `${t.source}:${t.id}` || t.status === 'resolved'}
                    onClick={() => void handleSupportStatus(t, 'resolved')}
                  >
                    Valider
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={processingTicketId === `${t.source}:${t.id}` || t.status === 'closed'}
                    onClick={() => void handleSupportStatus(t, 'closed')}
                  >
                    Clore
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={processingTicketId === `${t.source}:${t.id}`}
                    onClick={() => void handleArchiveSupportTicket(t)}
                  >
                    Supprimer
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate('/admin/messenger', {
                      state: { supportTicket: { source: String(t.source), id: String(t.id) } },
                    })}
                  >
                    Ouvrir la Messagerie
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* JOURNAUX D'AUDIT */}
        {activeTab === 'audit' && content && (
          <div className="space-y-3">
            {canDeleteAuditLogs && (
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={clearingAuditLogs || deletingAuditLog !== null}
                  onClick={handleClearAuditLogs}
                >
                  <Trash2 className="h-4 w-4" />
                  Supprimer tout
                </Button>
              </div>
            )}
            <div className="rounded-lg border border-[#25263A]/10 bg-white overflow-x-auto">
              <table className="w-full min-w-[820px] text-start text-xs">
                <thead className="whitespace-nowrap bg-[#F7F4EF]/60 border-b border-[#25263A]/10 text-[#64667A]">
                  <tr>
                    <th className="px-5 py-3 text-start">Horodatage</th>
                    <th className="px-5 py-3 text-start">Acteur</th>
                    <th className="px-5 py-3 text-start">Action</th>
                    <th className="px-5 py-3 text-start">Entité</th>
                    {canDeleteAuditLogs && <th className="px-5 py-3 text-end">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#25263A]/10">
                  {content.auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={canDeleteAuditLogs ? 5 : 4} className="px-5 py-8 text-center text-[#64667A]">
                        Aucun journal d’audit.
                      </td>
                    </tr>
                  ) : content.auditLogs.map((l) => (
                    <tr key={String(l.id)}>
                      <td className="px-5 py-2.5 font-mono tabular-nums">{formatDate(String(l.created_at))}</td>
                      <td className="px-5 py-2.5">{String(l.actor_email || 'système')}</td>
                      <td className="px-5 py-2.5 font-mono">{String(l.action)}</td>
                      <td className="px-5 py-2.5 font-mono text-[#64667A]">
                        {String(l.entity_type)}:{String(l.entity_id).slice(0, 8)}
                      </td>
                      {canDeleteAuditLogs && (
                        <td className="px-5 py-2 text-end">
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            disabled={clearingAuditLogs || deletingAuditLog !== null}
                            aria-label={`Supprimer l’entrée ${String(l.action)}`}
                            onClick={() => handleDeleteAuditLog(String(l.id))}
                          >
                            <Trash2 className="h-4 w-4" />
                            Supprimer
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      <Modal
        open={editingExpertProfile !== null}
        onClose={() => {
          if (!savingExpertProfile) setEditingExpertProfile(null);
        }}
        title={editingExpertProfile ? `Modifier le profil · ${editingExpertProfile.displayName}` : 'Modifier le profil'}
      >
        {editingExpertProfile && (
          <form onSubmit={handleSaveExpertProfile} className="space-y-4">
            <Input
              label="Nom affiché"
              value={editingExpertProfile.displayName}
              onChange={(event) => setEditingExpertProfile({ ...editingExpertProfile, displayName: event.target.value })}
              minLength={2}
              maxLength={120}
              required
            />
            <Input
              label="Titre professionnel"
              value={editingExpertProfile.headline}
              onChange={(event) => setEditingExpertProfile({ ...editingExpertProfile, headline: event.target.value })}
              minLength={2}
              maxLength={160}
              required
            />
            <Input
              label="Spécialité"
              value={editingExpertProfile.specialty}
              onChange={(event) => setEditingExpertProfile({ ...editingExpertProfile, specialty: event.target.value })}
              minLength={2}
              maxLength={120}
              required
            />
            <Input
              label="Années d’expérience"
              type="number"
              min={0}
              max={80}
              value={editingExpertProfile.yearsExperience}
              onChange={(event) => setEditingExpertProfile({ ...editingExpertProfile, yearsExperience: event.target.value })}
              required
            />
            <Input
              label="Consultations terminées"
              type="number"
              min={0}
              max={2147483647}
              step={1}
              value={editingExpertProfile.completedConsultations}
              onChange={(event) => setEditingExpertProfile({ ...editingExpertProfile, completedConsultations: event.target.value })}
              required
            />
            <Input
              label="Codes de langue (fr, en, ar ; séparés par des virgules)"
              value={editingExpertProfile.languages}
              onChange={(event) => setEditingExpertProfile({ ...editingExpertProfile, languages: event.target.value })}
              placeholder="fr, en"
              required
            />
            <Textarea
              label="Biographie professionnelle"
              rows={6}
              value={editingExpertProfile.biography}
              onChange={(event) => setEditingExpertProfile({ ...editingExpertProfile, biography: event.target.value })}
              maxLength={5000}
              required
            />
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" disabled={savingExpertProfile} onClick={() => setEditingExpertProfile(null)}>
                Annuler
              </Button>
              <Button type="submit" disabled={savingExpertProfile}>
                {savingExpertProfile ? 'Enregistrement...' : 'Enregistrer le profil'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={avatarExpert !== null}
        onClose={() => {
          if (!avatarSaving) setAvatarExpert(null);
        }}
        title={avatarExpert ? `Photo de profil · ${String(avatarExpert.display_name)}` : 'Photo de profil'}
        maxWidth="max-w-3xl"
      >
        {avatarExpert && (
          <div className="space-y-5">
            {avatarError && <AlertBanner tone="error">{avatarError}</AlertBanner>}
            <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
              <div className="space-y-4">
                <input
                  ref={avatarFileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={handleAvatarFile}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => avatarFileInputRef.current?.click()}>
                    <ImagePlus className="h-4 w-4" />
                    {avatarImage ? 'Importer / remplacer' : 'Importer une photo'}
                  </Button>
                  {avatarImage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAvatarZoom(1);
                        setAvatarRotation(0);
                        setAvatarOffset({ x: 0, y: 0 });
                      }}
                    >
                      <RotateCcw className="h-4 w-4" />
                      Réinitialiser le cadrage
                    </Button>
                  )}
                </div>
                <p className="text-xs text-[#64667A]">JPG, JPEG, PNG ou WebP · 15 Mo maximum. La photo est optimisée lors de l’enregistrement.</p>

                {avatarImage ? (
                  <div className="space-y-2">
                    <canvas
                      ref={avatarCanvasRef}
                      width={AVATAR_WIDTH}
                      height={AVATAR_HEIGHT}
                      aria-label="Aperçu recadré de la photo de profil. Faites glisser l’image pour la repositionner."
                      className="mx-auto block max-h-[60vh] w-full max-w-[300px] touch-none cursor-move rounded-md bg-[#191E32] object-contain"
                      onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setAvatarDrag({
                          clientX: event.clientX,
                          clientY: event.clientY,
                          offsetX: avatarOffset.x,
                          offsetY: avatarOffset.y,
                        });
                      }}
                      onPointerMove={(event) => {
                        if (!avatarDrag) return;
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setAvatarOffset({
                          x: avatarDrag.offsetX + ((event.clientX - avatarDrag.clientX) * AVATAR_WIDTH) / bounds.width,
                          y: avatarDrag.offsetY + ((event.clientY - avatarDrag.clientY) * AVATAR_HEIGHT) / bounds.height,
                        });
                      }}
                      onPointerUp={() => setAvatarDrag(null)}
                      onPointerCancel={() => setAvatarDrag(null)}
                    />
                    <p className="text-center text-xs text-[#64667A]">Faites glisser la photo pour ajuster sa position.</p>
                  </div>
                ) : (
                  <div className="mx-auto flex aspect-[3/4] w-full max-w-[300px] items-center justify-center rounded-md bg-[#191E32] p-6 text-center font-serif text-xl text-[#C7A66A]">
                    {String(avatarExpert.display_name)}
                  </div>
                )}
              </div>

              <div className="space-y-5">
                <div>
                  <div className="mb-2 flex items-center justify-between text-xs font-medium text-[#25263A]">
                    <label htmlFor="avatar-zoom">Zoom</label>
                    <span>{avatarZoom.toFixed(1)}×</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <ZoomOut className="h-4 w-4 text-[#64667A]" />
                    <input
                      id="avatar-zoom"
                      type="range"
                      min="1"
                      max="3"
                      step="0.05"
                      value={avatarZoom}
                      disabled={!avatarImage}
                      onChange={(event) => setAvatarZoom(Number(event.target.value))}
                      className="w-full accent-[#C7A66A]"
                    />
                    <ZoomIn className="h-4 w-4 text-[#64667A]" />
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between text-xs font-medium text-[#25263A]">
                    <label htmlFor="avatar-rotation">Rotation</label>
                    <span>{avatarRotation}°</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <RotateCcw className="h-4 w-4 text-[#64667A]" />
                    <input
                      id="avatar-rotation"
                      type="range"
                      min="-180"
                      max="180"
                      step="1"
                      value={avatarRotation}
                      disabled={!avatarImage}
                      onChange={(event) => setAvatarRotation(Number(event.target.value))}
                      className="w-full accent-[#C7A66A]"
                    />
                    <RotateCcw className="h-4 w-4 rotate-180 text-[#64667A]" />
                  </div>
                </div>

                <div className="rounded-md border border-[#25263A]/10 bg-white p-3 text-xs text-[#64667A]">
                  Aperçu au format portrait 3:4, identique au cadrage utilisé sur les cartes et profils des conseillers.
                </div>

                {typeof avatarExpert.avatar_url === 'string' && avatarExpert.avatar_url && (
                  <Button
                    variant="danger"
                    className="w-full"
                    disabled={avatarSaving}
                    onClick={handleRemoveAvatar}
                  >
                    <Trash2 className="h-4 w-4" />
                    Restaurer l’image par défaut
                  </Button>
                )}
                <Button
                  className="w-full"
                  disabled={!avatarImage || avatarSaving}
                  onClick={handleSaveAvatar}
                >
                  {avatarSaving ? 'Enregistrement...' : 'Enregistrer la photo'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </DashboardShell>
  );
}
