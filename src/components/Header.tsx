import React, { useState } from 'react';
import Logo from './Logo';
import { User } from 'firebase/auth';
import { logout } from '../auth';
import { LogOut, User as UserIcon, CheckCircle2 } from 'lucide-react';

interface HeaderProps {
  user: User | null;
}

export default function Header({ user }: HeaderProps) {
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    try {
      setLoggingOut(true);
      await logout();
    } catch (err) {
      console.error('Failed to log out:', err);
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <header className="bg-white border-b border-slate-200 shadow-xs sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 sm:py-3.5 flex items-center justify-between gap-2 sm:gap-4">
        {/* Left Side: Brand Logo & Title */}
        <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
          <Logo size="md" className="w-9 h-9 sm:w-11 sm:h-11 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <span className="text-lg sm:text-2xl font-bold bg-gradient-to-r from-indigo-700 via-blue-600 to-emerald-600 bg-clip-text text-transparent tracking-tight whitespace-nowrap">
                ZenUploader
              </span>
              <span className="hidden md:inline-block text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100">
                v2.0
              </span>
            </div>
            <p className="text-[11px] sm:text-xs text-slate-500 font-medium hidden sm:block truncate">
              Automated Open Science & Zenodo Upload Suite
            </p>
          </div>
        </div>

        {/* Right Side: User Profile / Auth Status */}
        {user ? (
          <div className="flex items-center gap-2 shrink-0">
            <div
              className="flex items-center gap-2 text-xs text-slate-700 bg-slate-100/90 hover:bg-slate-100 px-2.5 sm:px-3 py-1.5 rounded-full border border-slate-200 shadow-2xs transition-colors"
              title={`Signed in as ${user.email || 'User'}`}
            >
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>

              {/* User Email: Truncated safely on mobile screens */}
              <span className="font-medium max-w-[110px] sm:max-w-[180px] md:max-w-[240px] truncate text-[11px] sm:text-xs text-slate-700">
                {user.email || 'Signed In'}
              </span>
            </div>

            {/* Logout button */}
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              aria-label="Sign out"
              title="Sign out of your account"
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-colors shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-slate-500 bg-slate-50 px-2.5 py-1 rounded-full border border-slate-200/80 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
            <span className="text-[11px] font-medium text-slate-600 hidden xs:inline">Guest Mode</span>
          </div>
        )}
      </div>
    </header>
  );
}
