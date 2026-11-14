/**
 * Zolymarket — Responsive Top Navigation Bar
 *
 * Desktop (md+): Strict three-zone single-row contract:
 *   [Brand wordmark] — [Single-line view navigation] — [Dual-Rail Auth action]
 * Mobile (<md): Compact 56px sticky bar with collapsible menu panel so
 * sticky chrome stays well below 15% of viewport height and never clips on 320px+.
 */

import React, { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { usePollar } from '@pollar/react';
import { useAuth } from '../contexts/AuthContext.tsx';

export type ActiveView = 'markets' | 'host' | 'pollar' | 'creators' | 'schema' | 'setup';

interface HeaderProps {
  activeView: ActiveView;
  onNavigate: (view: ActiveView) => void;
}

export const Header: React.FC<HeaderProps> = ({ activeView, onNavigate }) => {
  const { user, loading, walletSession, openAuthModal } = useAuth();
  const { isAuthenticated: pollarAuthed } = usePollar();
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

  const isConnected = Boolean(walletSession || pollarAuthed || user);

  const activeAccountLabel = walletSession
    ? `${walletSession.rail === 'zcash' ? 'Zcash' : 'Polygon'} ${walletSession.address.slice(
        0,
        5
      )}...${walletSession.address.slice(-3)}`
    : pollarAuthed
    ? 'Pollar Connected'
    : user
    ? `Account (${user.displayName?.split(' ')[0] || 'Google'})`
    : 'Sign in';

  return (
    <header className="sticky top-0 z-30 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)]">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 h-14 md:h-16 flex items-center justify-between gap-3 md:gap-8">
        {/* Zone 1: Brand wordmark */}
        <button
          type="button"
          onClick={() => handleNavClick('markets')}
          className="font-display text-lg sm:text-xl font-bold tracking-tight var(--text-primary) whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] rounded min-h-[40px] flex items-center"
        >
          Zolymarket
        </button>

        {/* Zone 2: Desktop single-line text navigation links }}
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
                className={`text-sm font-medium whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] ${
                  isActive
                    ? 'var(--text-primary) border-[var(--accent-blue)]'
                    : 'var(--text-secondary) border-transparent hover:text-[var(--text-primary)] hover:border-[var(--border-subtle)]'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary Dual-Rail auth action + mobile menu trigger */}
        <div className="flex items-center gap-2 shrink-0">
          {loading && !walletSession && !pollarAuthed ? (
            <span className="text-xs var(--text-muted) whitespace-nowrap">Checking auth</span>
          ) : isConnected ? (
            <button
              type="button"
              onClick={() =>
                openAuthModal(walletSession?.rail === 'polygon' ? 'polygon' : 'zcash')
              }
              title="Manage Zcash, Pollar / Polygon, or optional Google session"
              className="min-h-[40px] px-3 sm:px-4 py-2 text-xs font-semibold var(--text-secondary) bg-[var(--border-subtle)] rounded-lg hover:bg-[rgba(59,130,246,0.1)] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] max-w-[156px] sm:max-w-none truncate font-mono"
            >
              {activeAccountLabel}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => openAuthModal('zcash')}
              className="min-h-[40px] px-3 sm:px-4 py-2 text-xs font-semibold var(--text-primary) bg-[var(--bg-surface)] rounded-lg:hover:bg-[var(--border-subtle)] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]"
            >
              <span className="sm:hidden">Sign in</span>
              <span className="hidden sm:inline">Sign in · Zcash / Pollar</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-primary-nav"
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            className="md:hidden min-h-[40px] min-w-[40px] inline-flex items-center justify-center var(--text-secondary) hover:text-[var(--text-primary)] bg-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]"
          >
            {mobileMenuOpen ? (
              <X className="w-5 h-5" aria-hidden="true" />
            ) : (
              <Menu className="w-5 h-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Collapsible Mobile Navigation Drawer }}
      {mobileMenuOpen && (
        <nav
          id="mobile-primary-nav"
          aria-label="Mobile navigation"
          className="md:hidden border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3 space-y-1"
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
                    ? 'bg-[rgba(59,130,246,0.1)] text-[var(--text-primary)] font-semibold'
                    : 'var(--text-secondary) hover:bg-[var(--border-subtle)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span>{item.label}</span>
                {isActive && (
                  <span className="text-xs font-mono var(--accent-cyan)">Active</span>
                )}
              </button>
            );
          })}
        </nav>
      )}
    </header>
  );
};