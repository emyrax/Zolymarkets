/**
 * Zolymarket — Top Navigation Bar
 *
 * Follows a strict three-zone single-row layout:
 * [Brand wordmark] — [Single-line view navigation] — [Google Auth action]
 */

import React from 'react';
import { useAuth } from '../contexts/AuthContext.tsx';

export type ActiveView = 'markets' | 'host' | 'pollar' | 'creators' | 'schema' | 'setup';

interface HeaderProps {
  activeView: ActiveView;
  onNavigate: (view: ActiveView) => void;
}

export const Header: React.FC<HeaderProps> = ({ activeView, onNavigate }) => {
  const { user, loading, signInWithGoogle, signOutUser } = useAuth();

  const navItems: { id: ActiveView; label: string }[] = [
    { id: 'markets', label: 'Markets' },
    { id: 'host', label: 'Host Market' },
    { id: 'pollar', label: 'Pollar Pay' },
    { id: 'creators', label: 'Creators' },
    { id: 'setup', label: 'Zingo Setup' },
  ];

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
      <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Brand wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('markets')}
          className="font-display text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 rounded"
        >
          Zolymarket
        </button>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav aria-label="Primary navigation" className="flex items-center gap-6 overflow-x-auto">
          {navItems.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
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

        {/* Zone 3: Single primary auth action */}
        <div className="shrink-0">
          {loading ? (
            <span className="text-xs text-slate-400 whitespace-nowrap">Checking auth</span>
          ) : user ? (
            <button
              type="button"
              onClick={() => void signOutUser()}
              title={`Signed in as ${user.email || user.displayName || 'User'}`}
              className="px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              Sign out ({user.displayName?.split(' ')[0] || 'Account'})
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              Sign in with Google
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
