import React, { useState } from 'react';
import { X, AlertCircle, CheckCircle2 } from 'lucide-react';

export function submitFormOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C7A66A] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0 rounded-md';

  const variants: Record<string, string> = {
    primary: 'bg-[#101323] text-[#F7F4EF] hover:bg-[#191E32]',
    secondary: 'bg-[#C7A66A] text-[#101323] hover:bg-[#B49154]',
    outline: 'border border-[#25263A]/20 bg-transparent text-[#25263A] hover:bg-[#25263A]/5',
    ghost: 'bg-transparent text-[#25263A] hover:bg-[#25263A]/5',
    danger: 'bg-[#991B1B] text-white hover:bg-[#7F1D1D]',
  };

  const sizes: Record<string, string> = {
    sm: 'px-3.5 py-1.5 text-xs min-h-[36px]',
    md: 'px-5 py-2.5 text-sm min-h-[40px]',
    lg: 'px-7 py-3 text-sm min-h-[44px]',
  };

  return (
    <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Input({
  label,
  error,
  className = '',
  id,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string }) {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
  const errorId = inputId ? `${inputId}-error` : undefined;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-xs font-medium tracking-wide text-[#25263A]">
          {label}
        </label>
      )}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full min-h-[42px] rounded-md border ${error ? 'border-[#B91C1C] focus:border-[#B91C1C]' : 'border-[#25263A]/20 focus:border-[#C7A66A]'} bg-white px-3.5 py-2 text-sm text-[#25263A] placeholder:text-[#64667A]/70 focus:outline-none ${className}`}
        {...props}
      />
      {error && <p id={errorId} role="alert" className="text-xs text-[#991B1B]">{error}</p>}
    </div>
  );
}

export function Textarea({
  label,
  error,
  className = '',
  id,
  onKeyDown,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; error?: string }) {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
  const errorId = inputId ? `${inputId}-error` : undefined;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-xs font-medium tracking-wide text-[#25263A]">
          {label}
        </label>
      )}
      <textarea
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented) submitFormOnEnter(event);
        }}
        className={`w-full rounded-md border ${error ? 'border-[#B91C1C] focus:border-[#B91C1C]' : 'border-[#25263A]/20 focus:border-[#C7A66A]'} bg-white px-3.5 py-2.5 text-sm text-[#25263A] placeholder:text-[#64667A]/70 focus:outline-none ${className}`}
        {...props}
      />
      {error && <p id={errorId} role="alert" className="text-xs text-[#991B1B]">{error}</p>}
    </div>
  );
}

export function Select({
  label,
  error,
  className = '',
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string; error?: string }) {
  return (
    <div className="space-y-1.5">
      {label && <label className="block text-xs font-medium tracking-wide text-[#25263A]">{label}</label>}
      <select
        className={`w-full min-h-[42px] rounded-md border border-[#25263A]/20 bg-white px-3 py-2 text-sm text-[#25263A] focus:border-[#C7A66A] focus:outline-none ${className}`}
        {...props}
      >
        {children}
      </select>
      {error && <p className="text-xs text-[#991B1B]">{error}</p>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#101323]/60 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true">
      <div className={`w-full ${maxWidth} rounded-lg border border-[#25263A]/15 bg-[#F7F4EF] shadow-xl max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between border-b border-[#25263A]/10 px-6 py-4">
          <h3 className="font-serif text-2xl font-medium text-[#101323]">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Fermer la fenêtre"
            className="rounded-md p-1.5 text-[#64667A] hover:bg-[#25263A]/10 hover:text-[#101323]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

export function AlertBanner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'error' | 'warning';
  children: React.ReactNode;
}) {
  const styles: Record<string, string> = {
    info: 'border-[#25263A]/15 bg-white text-[#25263A]',
    success: 'border-[#166534]/25 bg-[#F0FDF4] text-[#166534]',
    error: 'border-[#991B1B]/25 bg-[#FEF2F2] text-[#991B1B]',
    warning: 'border-[#92400E]/25 bg-[#FFFBEB] text-[#92400E]',
  };
  return (
    <div className={`flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm ${styles[tone]}`}>
      {tone === 'success' ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SafeImage({
  src,
  alt,
  className = '',
  fallbackTitle,
}: {
  src?: string | null;
  alt: string;
  className?: string;
  fallbackTitle?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-[#191E32] text-[#C7A66A] ${className}`}
        aria-label={alt}
      >
        <div className="px-4 text-center">
          <div className="font-serif text-xl tracking-wide">{fallbackTitle || 'Au-delà des Étoiles'}</div>
        </div>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[#25263A]/10 bg-white px-6 py-12 text-center">
      <h4 className="font-serif text-2xl font-medium text-[#101323]">{title}</h4>
      <p className="mx-auto mt-2 max-w-md text-sm text-[#64667A]">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
