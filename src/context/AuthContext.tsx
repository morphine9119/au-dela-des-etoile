import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, clearAuthToken, setAuthToken } from '../lib/api';
import type { AuthUser } from '../types';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refreshUser: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (payload: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone: string;
    preferredLanguage?: 'en' | 'fr' | 'ar';
    referralCode?: string;
    termsAccepted: boolean;
    marketingConsent?: boolean;
  }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  hasRole: (role: 'client' | 'expert' | 'admin' | 'staff') => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const data = await apiFetch<{ user: AuthUser | null }>('/api/auth/me');
      if (!data.user) {
        clearAuthToken();
      }
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (email: string, password: string): Promise<AuthUser> => {
    const loginRes = await apiFetch<{ user: AuthUser | null; token?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (loginRes.token) {
      setAuthToken(loginRes.token);
    }
    const data = await apiFetch<{ user: AuthUser | null }>('/api/auth/me');
    const resolvedUser = data.user || loginRes.user;
    if (!resolvedUser) throw new Error('Impossible de charger le profil utilisateur');
    setUser(resolvedUser);
    return resolvedUser;
  };

  const register = async (payload: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone: string;
    preferredLanguage?: 'en' | 'fr' | 'ar';
    referralCode?: string;
    termsAccepted: boolean;
    marketingConsent?: boolean;
  }): Promise<AuthUser> => {
    const registerRes = await apiFetch<{ user: AuthUser | null; token?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (registerRes.token) {
      setAuthToken(registerRes.token);
    }
    const data = await apiFetch<{ user: AuthUser | null }>('/api/auth/me');
    const resolvedUser = data.user || registerRes.user;
    if (!resolvedUser) throw new Error('Impossible de charger le profil utilisateur');
    setUser(resolvedUser);
    return resolvedUser;
  };

  const logout = async () => {
    clearAuthToken();
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore network errors on logout
    }
    setUser(null);
  };

  const hasRole = (role: 'client' | 'expert' | 'admin' | 'staff') => {
    return Boolean(user?.roles?.includes(role));
  };

  return (
    <AuthContext.Provider value={{ user, loading, refreshUser, login, register, logout, hasRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
