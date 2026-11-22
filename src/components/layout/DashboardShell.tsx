import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, ArrowLeft } from 'lucide-react';
import { brandConfig } from '../../config/brand';
import { useAuth } from '../../context/AuthContext';

export interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  badgeStyle?: 'notification';
}

export function DashboardShell({
  portalTitle,
  subtitle,
  navItems,
  activeTab,
  onSelectTab,
  headerActions,
  children,
}: {
  portalTitle: string;
  subtitle?: string;
  navItems: NavItem[];
  activeTab: string;
  onSelectTab: (id: string) => void;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="min-h-screen w-full bg-[#F7F4EF] text-[#25263A] flex flex-col lg:flex-row">
      {/* Barre latérale */}
      <aside className="w-full lg:sticky lg:top-0 lg:h-screen lg:w-[270px] shrink-0 border-b lg:border-b-0 lg:border-e border-[#25263A]/10 bg-[#101323] text-[#F7F4EF] flex flex-col">
        <div className="px-6 py-5 border-b border-white/10">
          <Link to="/" className="font-serif text-xl font-semibold text-[#F7F4EF] block">
            {brandConfig.name}
          </Link>
          <div className="mt-1 text-xs text-[#C7A66A]">{portalTitle}</div>
        </div>

        <nav className="flex min-h-0 lg:flex-col gap-1 overflow-x-auto lg:overflow-x-hidden lg:overflow-y-auto px-3 py-4 flex-1">
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-md px-3.5 py-2.5 text-sm font-medium text-[#F7F4EF]/75 transition-colors hover:bg-white/5 hover:text-[#F7F4EF] whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Accueil</span>
          </Link>
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`flex items-center justify-between gap-3 rounded-md px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-[#191E32] text-[#C7A66A]'
                    : 'text-[#F7F4EF]/75 hover:bg-white/5 hover:text-[#F7F4EF]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  {item.icon}
                  <span>{item.label}</span>
                </span>
                {item.badge !== undefined && item.badge > 0 && (
                  item.badgeStyle === 'notification' ? (
                    <span
                      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-white"
                      aria-label={`${item.badge} notification${item.badge === 1 ? '' : 's'}`}
                    >
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  ) : (
                    <span className="font-mono text-xs tabular-nums text-[#C7A66A]">{item.badge}</span>
                  )
                )}
              </button>
            );
          })}
        </nav>

        <div className="hidden lg:block border-t border-white/10 p-4 space-y-2">
          <div className="text-xs text-[#F7F4EF]/60 truncate">{user?.email}</div>
          {user?.is_demo && (
            <div className="text-[11px] text-[#C7A66A]">Compte Démo</div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Link
              to="/"
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-white/15 px-3 py-1.5 text-xs text-[#F7F4EF]/80 hover:bg-white/5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Site Public
            </Link>
            <button
              type="button"
              onClick={async () => {
                await logout();
                navigate('/');
              }}
              className="inline-flex items-center justify-center rounded-md border border-white/15 p-1.5 text-[#F7F4EF]/80 hover:bg-white/5"
              title="Déconnexion"
              aria-label="Déconnexion"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Espace principal pleine largeur */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="w-full border-b border-[#25263A]/10 bg-white px-6 py-4 lg:px-10">
          <div className="flex w-full flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-xs text-[#64667A]">
                {location.pathname} {subtitle ? `· ${subtitle}` : ''}
              </div>
              <h1 className="font-serif text-2xl font-medium text-[#101323]">
                {navItems.find((n) => n.id === activeTab)?.label || portalTitle}
              </h1>
            </div>
            {headerActions && <div className="flex items-center gap-3">{headerActions}</div>}
          </div>
        </header>

        <main className="flex-1 w-full p-6 lg:px-10 lg:py-8">
          <div className="w-full">{children}</div>
        </main>
      </div>
    </div>
  );
}
