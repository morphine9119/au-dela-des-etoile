import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Menu, X, ChevronDown, LogOut } from 'lucide-react';
import { brandConfig } from '../../config/brand';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../../i18n/I18nContext';
import { apiFetch } from '../../lib/api';

export function Header() {
  const { user, logout, hasRole } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [servicesMenuOpen, setServicesMenuOpen] = useState(false);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const isClient = Boolean(user?.roles?.includes('client'));
  const isAdmin = hasRole('admin') || hasRole('staff');

  useEffect(() => {
    if (!isClient && !isAdmin) {
      setUnreadNotificationCount(0);
      return;
    }

    let active = true;
    const refreshNotifications = () => {
      const request = isAdmin
        ? apiFetch<{ pendingApplications: number; unreadSupportMessages: number }>('/api/admin/overview')
          .then(({ pendingApplications, unreadSupportMessages }) => {
            if (active) setUnreadNotificationCount(pendingApplications + unreadSupportMessages);
          })
        : apiFetch<{ notifications: Array<{ is_read: number }> }>('/api/client/notifications')
          .then(({ notifications }) => {
            if (active) setUnreadNotificationCount(notifications.filter((notification) => !notification.is_read).length);
          });
      request.catch((err) => {
        if (active) console.error('Unable to refresh notifications:', err);
      });
    };

    refreshNotifications();
    const interval = window.setInterval(refreshNotifications, 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [isAdmin, isClient, user?.id]);

  const primaryHref = user
    ? hasRole('admin')
      ? '/admin'
      : hasRole('expert')
      ? '/expert/dashboard'
      : '/account'
    : '/login';

  const primaryLabel = user
    ? hasRole('admin')
      ? t('nav_admin_portal')
      : hasRole('expert')
      ? t('nav_expert_portal')
      : t('nav_account')
    : t('nav_login');

  const navigateToPrimary = async () => {
    if (isClient) {
      try {
        await apiFetch('/api/client/notifications/read-all', { method: 'POST' });
        setUnreadNotificationCount(0);
      } catch (err) {
        console.error('Unable to mark client notifications as read:', err);
      }
    }
    navigate(primaryHref);
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-[#25263A]/10 bg-[#F7F4EF]/70 backdrop-blur-sm">
      <div className="flex w-full items-center justify-between gap-8 px-6 py-4 lg:px-12 xl:px-16">
        {/* Zone 1 : Marque sur une ligne */}
        <Link
          to="/"
          className="font-serif text-2xl font-semibold tracking-tight text-[#101323] whitespace-nowrap shrink-0"
        >
          {brandConfig.name}
        </Link>

        {/* Zone 2 : Navigation principale en français */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-[#25263A]">
          <Link to="/" className="hover:text-[#101323] hover:underline underline-offset-4 whitespace-nowrap shrink-0">
            {t('nav_home')}
          </Link>
          <div className="relative">
            <button
              type="button"
              onClick={() => setServicesMenuOpen((v) => !v)}
              onBlur={() => setTimeout(() => setServicesMenuOpen(false), 180)}
              className="inline-flex items-center gap-1 hover:text-[#101323] whitespace-nowrap shrink-0 py-1"
            >
              <span>{t('nav_experts')}</span>
              <ChevronDown className="h-3.5 w-3.5 text-[#64667A]" />
            </button>
            {servicesMenuOpen && (
              <div className="absolute start-0 top-full mt-2 w-60 rounded-md border border-[#25263A]/15 bg-white py-2 shadow-lg">
                <Link to="/experts" className="block px-4 py-2 text-sm text-[#25263A] hover:bg-[#F7F4EF]">
                  Tous les Conseillers Vérifiés
                </Link>
                <Link to="/experts/chat" className="block px-4 py-2 text-sm text-[#25263A] hover:bg-[#F7F4EF]">
                  Tchat en Direct
                </Link>
                <Link to="/experts/phone" className="block px-4 py-2 text-sm text-[#25263A] hover:bg-[#F7F4EF]">
                  Consultations par Téléphone
                </Link>
              </div>
            )}
          </div>
          <Link to="/tarot" className="hover:text-[#101323] hover:underline underline-offset-4 whitespace-nowrap shrink-0">
            {t('nav_tarot')}
          </Link>
          <Link to="/horoscope" className="hover:text-[#101323] hover:underline underline-offset-4 whitespace-nowrap shrink-0">
            Horoscopes
          </Link>
          <Link to="/blog" className="hover:text-[#101323] hover:underline underline-offset-4 whitespace-nowrap shrink-0">
            {t('nav_journal')}
          </Link>
        </nav>

        {/* Zone 3 : Actions compte */}
        <div className="hidden md:flex items-center gap-2.5 shrink-0">
          {user ? (
            <>
              <button
                type="button"
                onClick={() => void navigateToPrimary()}
                aria-label={(isClient || isAdmin) && unreadNotificationCount > 0
                  ? `${primaryLabel}, ${unreadNotificationCount} notification${unreadNotificationCount === 1 ? '' : 's'} non lue${unreadNotificationCount === 1 ? '' : 's'}`
                  : primaryLabel}
                className="inline-flex items-center gap-2 rounded-md bg-[#101323] px-4 py-2 text-xs font-medium text-[#F7F4EF] transition-colors hover:bg-[#191E32] whitespace-nowrap shrink-0"
              >
                {primaryLabel}
                {(isClient || isAdmin) && unreadNotificationCount > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-white">
                    {unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={async () => {
                  await logout();
                  navigate('/');
                }}
                title="Se Déconnecter"
                aria-label="Se Déconnecter"
                className="inline-flex items-center gap-1.5 rounded-md border border-[#25263A]/20 px-3 py-2 text-xs font-medium text-[#25263A] transition-colors hover:bg-[#25263A]/5 whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Déconnexion</span>
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-md border border-[#25263A]/20 px-4 py-2 text-xs font-medium text-[#101323] transition-colors hover:bg-[#25263A]/5 whitespace-nowrap shrink-0"
              >
                {t('nav_login')}
              </Link>
              <Link
                to="/register"
                className="rounded-md bg-[#101323] px-4 py-2 text-xs font-medium text-[#F7F4EF] transition-colors hover:bg-[#191E32] whitespace-nowrap shrink-0"
              >
                {t('nav_register')}
              </Link>
            </>
          )}
        </div>

        {/* Bouton menu mobile */}
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Ouvrir le menu de navigation"
          className="md:hidden rounded-md p-2 text-[#101323] hover:bg-[#25263A]/10"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Menu Mobile */}
      {mobileOpen && (
        <div className="border-t border-[#25263A]/10 bg-[#F7F4EF] px-6 py-4 md:hidden">
          <div className="flex flex-col space-y-3 text-sm font-medium text-[#25263A]">
            <Link to="/" onClick={() => setMobileOpen(false)} className="py-1.5">
              {t('nav_home')}
            </Link>
            <Link to="/experts" onClick={() => setMobileOpen(false)} className="py-1.5">
              {t('nav_experts')}
            </Link>
            <Link to="/tarot" onClick={() => setMobileOpen(false)} className="py-1.5">
              {t('nav_tarot')}
            </Link>
            <Link to="/horoscope" onClick={() => setMobileOpen(false)} className="py-1.5">
              Horoscopes
            </Link>
            <Link to="/blog" onClick={() => setMobileOpen(false)} className="py-1.5">
              {t('nav_journal')}
            </Link>
            <Link to="/become-an-expert" onClick={() => setMobileOpen(false)} className="py-1.5">
              {t('nav_become_expert')}
            </Link>
            <div className="border-t border-[#25263A]/10 pt-3 flex flex-col gap-2">
              <Link
                to={primaryHref}
                onClick={(event) => {
                  event.preventDefault();
                  setMobileOpen(false);
                  void navigateToPrimary();
                }}
                aria-label={(isClient || isAdmin) && unreadNotificationCount > 0
                  ? `${primaryLabel}, ${unreadNotificationCount} notification${unreadNotificationCount === 1 ? '' : 's'} non lue${unreadNotificationCount === 1 ? '' : 's'}`
                  : primaryLabel}
                className="flex items-center justify-center gap-2 rounded-md bg-[#101323] px-4 py-2.5 text-center text-sm font-medium text-[#F7F4EF]"
              >
                {primaryLabel}
                {(isClient || isAdmin) && unreadNotificationCount > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-white">
                    {unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}
                  </span>
                )}
              </Link>
              {user ? (
                <button
                  type="button"
                  onClick={async () => {
                    await logout();
                    setMobileOpen(false);
                    navigate('/');
                  }}
                  className="rounded-md border border-[#25263A]/20 px-4 py-2 text-sm text-[#25263A]"
                >
                  Se Déconnecter
                </button>
              ) : (
                <Link
                  to="/register"
                  onClick={() => setMobileOpen(false)}
                  className="rounded-md border border-[#25263A]/20 px-4 py-2 text-center text-sm text-[#25263A]"
                >
                  {t('nav_register')}
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
