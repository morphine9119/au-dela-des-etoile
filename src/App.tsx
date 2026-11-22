import React from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Footer } from './components/layout/Footer';
import { Header } from './components/layout/Header';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WebSocketProvider } from './context/WebSocketContext';
import { I18nProvider } from './i18n/I18nContext';
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { ForgotPasswordPage, LoginPage, RegisterPage } from './pages/auth/AuthPages';
import { ClientDashboard } from './pages/client/ClientDashboard';
import { ExpertDashboard } from './pages/expert/ExpertDashboard';
import { BecomeExpertPage } from './pages/public/BecomeExpertPage';
import { BlogDetailPage, BlogPage, HoroscopePage, TarotPage } from './pages/public/ContentPages';
import { ExpertProfilePage } from './pages/public/ExpertProfilePage';
import { ExpertsPage } from './pages/public/ExpertsPage';
import { HomePage } from './pages/public/HomePage';
import { AboutPage, ContactPage, FaqPage, LegalPage } from './pages/public/StaticPages';
import type { UserRole } from './types';

function PublicLayout() {
  return (
    <div className="min-h-screen w-full flex flex-col bg-[#F7F4EF] text-[#25263A]">
      <Header />
      <main className="flex-1 w-full">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

function RequireRole({ allowed }: { allowed?: UserRole[] }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="min-h-screen w-full flex items-center justify-center bg-[#F7F4EF] text-sm text-[#64667A]">Vérification de votre session...</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (allowed && !user.roles.some((r) => allowed.includes(r))) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <WebSocketProvider>
          <HashRouter>
            <Routes>
              {/* Public Website */}
              <Route element={<PublicLayout />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/experts" element={<ExpertsPage />} />
                <Route path="/experts/chat" element={<ExpertsPage defaultMethod="chat" />} />
                <Route path="/experts/phone" element={<ExpertsPage defaultMethod="phone" />} />
                <Route path="/experts/:slug" element={<ExpertProfilePage />} />
                <Route path="/become-an-expert" element={<BecomeExpertPage />} />
                <Route path="/blog" element={<BlogPage />} />
                <Route path="/blog/:slug" element={<BlogDetailPage />} />
                <Route path="/horoscope" element={<HoroscopePage />} />
                <Route path="/tarot" element={<TarotPage />} />
                <Route path="/about" element={<AboutPage />} />
                <Route path="/contact" element={<ContactPage />} />
                <Route path="/faq" element={<FaqPage />} />
                <Route path="/privacy" element={<LegalPage type="privacy" />} />
                <Route path="/terms" element={<LegalPage type="terms" />} />
                <Route path="/cookies" element={<LegalPage type="cookies" />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              </Route>

              {/* Client Portal */}
              <Route element={<RequireRole />}>
                <Route path="/account" element={<Navigate to="/account/favorites" replace />} />
                <Route path="/account/*" element={<ClientDashboard />} />
              </Route>

              {/* Expert Portal */}
              <Route element={<RequireRole allowed={['expert', 'admin']} />}>
                <Route path="/expert" element={<Navigate to="/expert/dashboard" replace />} />
                <Route path="/expert/*" element={<ExpertDashboard />} />
              </Route>

              {/* Admin Portal */}
              <Route element={<RequireRole allowed={['admin', 'staff']} />}>
                <Route path="/admin" element={<Navigate to="/admin/experts" replace />} />
                <Route path="/admin/*" element={<AdminDashboard />} />
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </HashRouter>
        </WebSocketProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
