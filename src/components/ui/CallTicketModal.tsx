import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext';

export interface CallTicketExpertInfo {
  id: string;
  display_name: string;
  specialty?: string;
}

export function CallTicketModal({
  expert,
  onClose,
}: {
  expert: CallTicketExpertInfo | null;
  onClose: () => void;
}) {
  const { mainNumber } = useI18n();

  if (!expert) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#101323]/60 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={mainNumber}
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-md items-center justify-center rounded-md bg-[#EFEFEF] px-10 py-10 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          className="absolute right-2.5 top-2.5 rounded p-1 text-black/40 hover:bg-black/5 hover:text-black"
        >
          <X className="h-4 w-4" />
        </button>
        <a
          href={`tel:${mainNumber}`}
          className="font-sans text-4xl sm:text-5xl font-extrabold italic tracking-tight text-black hover:opacity-80 select-all"
        >
          {mainNumber}
        </a>
      </div>
    </div>
  );
}
