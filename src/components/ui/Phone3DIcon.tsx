import React from 'react';
import phoneImage from '../../assets/images/phone-3d.png';

export function Phone3DIcon({ size = 40, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      style={{ width: size, height: size }}
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-[#22C55E]/35 shadow-[0_3px_12px_rgba(22,163,74,0.32)] transition-all duration-300 ease-out ${className}`}
      aria-hidden="true"
    >
      <img
        src={phoneImage}
        alt=""
        className="h-full w-full object-cover scale-[1.17] brightness-[1.03] saturate-[0.95] select-none pointer-events-none"
        draggable={false}
      />
      <span
        className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_5px_rgba(255,255,255,0.35)]"
        aria-hidden="true"
      />
    </span>
  );
}

export function CallExpertPhoneButton({
  expertName,
  onClick,
  size = 40,
  className = '',
}: {
  expertName: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  size?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Appel direct avec ${expertName}`}
      title={`Appel direct — Ouvrir le ticket téléphonique pour ${expertName}`}
      className={`group inline-flex items-center justify-center rounded-full p-0.5 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#16A34A] shrink-0 ${className}`}
    >
      <Phone3DIcon size={size} className="group-hover:shadow-[0_6px_18px_rgba(22,163,74,0.45)]" />
    </button>
  );
}
