/**
 * Zolymarket — Responsive Top Navigation Bar
 *
 * Desktop (md+): Strict three-zone single-row contract:
 *   [Brand wordmark] — [Single-line view navigation] — [Google Auth action]
 * Mobile (<md): Compact 56px sticky bar with collapsible menu panel so
 * sticky chrome stays well below 15% of viewport height and never clips on 320px+.
 */

import React, { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';

export type ActiveView = 'markets' | 'host' | 'pollar' | 'creators' | 'schema' | 'setup';

interface HeaderProps {
  activeView: ActiveView;
  onNavigate: (view: ActiveView) => void;
}

export const Header: React.FC<HeaderProps> = ({ activeView, onNavigate }) => {
  const { user, loading, signInWithGoogle, signOutUser } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);

  const navItems: { id: ActiveView; label: string }[] = [
    { id: 'markets', label: 'Markets' },
    { id: 'host', label: 'Host Market' },
    { id: 'pollar', label: 'Pollar Pay' },
    { id: 'creators', label: 'Creators' },
    { id: 'setup', label: 'Zingo Setup' },
  ];

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [activeView]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileMenuOpen]);

  const handleNavClick = (view: ActiveView) => {
    setMobileMenuOpen(false);
    onNavigate(view);
  };

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 h-14 md:h-16 flex items-center justify-between gap-3 md:gap-8">
        {/* Zone 1: Brand wordmark */}
        <button
          type="button"
          onClick={() => handleNavClick('markets')}
          className="font-display text-lg sm:text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 rounded min-h-[40px] flex items-center"
        >
          Zolymarket
        </button>

        {/* Zone 2: Desktop single-line text navigation links */}
        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-6 overflow-x-auto no-scrollbar"
        >
          {navItems.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`text-sm font-medium whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 ${
                  isActive
                    ? 'text-slate-900 border-amber-600'
                    : 'text-slate-600 border-transparent hover:text-slate-900 hover:border-slate-300'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary auth action + mobile menu trigger */}
        <div className="flex items-center gap-2 shrink-0">
          {loading ? (
            <span className="text-xs text-slate-400 whitespace-nowrap">Checking auth</span>
          ) : user ? (
            <button
              type="button"
              onClick={() => void signOutUser()}
              title={`Signed in as ${user.email || user.displayName || 'User'}`}
              className="min-h-[40px] px-3 sm:px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 max-w-[140px] sm:max-w-none truncate"
            >
              Sign out ({user.displayName?.split(' ')[0] || 'Account'})
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              className="min-h-[40px] px-3 sm:px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              <span className="sm:hidden">Sign in</span>
              <span className="hidden sm:inline">Sign in with Google</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-primary-nav"
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            className="md:hidden min-h-[40px] min-w-[40px] inline-flex items-center justify-center text-slate-700 hover:text-slate-900 bg-slate-50 border border-slate-200 rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
          >
            {mobileMenuOpen ? (
              <X className="w-5 h-5" aria-hidden="true" />
            ) : (
              <Menu className="w-5 h-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Collapsible Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <nav
          id="mobile-primary-nav"
          aria-label="Mobile navigation"
          className="md:hidden border-t border-slate-200 bg-white px-4 py-3 space-y-1 shadow-lg"
        >
          {navItems.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full min-h-[44px] px-3.5 py-2.5 text-left text-sm font-medium rounded-lg transition-colors flex items-center justify-between cursor-pointer ${
                  isActive
                    ? 'bg-amber-50 text-slate-900 font-semibold'
                    : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <span>{item.label}</span>
                {isActive && (
                  <span className="text-xs font-mono text-amber-700">Active</span>
                )}
              </button>
            );
          })}
        </nav>
      )}
    </header>
  );
};
