import React from 'react';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export default function Logo({ className = '', size = 'md' }: LogoProps) {
  const sizeClasses = {
    sm: 'w-8 h-8 rounded-lg',
    md: 'w-10 h-10 rounded-xl',
    lg: 'w-12 h-12 rounded-2xl',
  };

  const iconSizes = {
    sm: 'w-4.5 h-4.5',
    md: 'w-5.5 h-5.5',
    lg: 'w-6.5 h-6.5',
  };

  return (
    <div
      className={`relative flex items-center justify-center shrink-0 bg-gradient-to-tr from-indigo-700 via-blue-600 to-emerald-500 shadow-sm shadow-indigo-500/20 text-white font-bold border border-white/20 overflow-hidden ${sizeClasses[size]} ${className}`}
      aria-label="ZenUploader Brand Icon"
    >
      {/* Decorative Glow / Geometry */}
      <div className="absolute -top-3 -right-3 w-7 h-7 bg-white/20 rounded-full blur-[2px]" />
      <div className="absolute -bottom-3 -left-3 w-7 h-7 bg-indigo-900/40 rounded-full blur-[2px]" />
      
      {/* Zen Science & Cloud Upload SVG Emblem */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`${iconSizes[size]} text-white drop-shadow-xs relative z-10`}
      >
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
        <path d="M12 12v9" />
        <path d="m8 16 4-4 4 4" />
      </svg>

      {/* Subtle bottom active pill indicator */}
      <div className="absolute bottom-0.5 inset-x-2 h-0.5 bg-emerald-300 rounded-full opacity-80" />
    </div>
  );
}
