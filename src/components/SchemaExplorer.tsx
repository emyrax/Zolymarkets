/**
 * Zolymarket — Cloud Firestore Schema, Security Rules & Architecture Explorer
 *
 * Displays the Cloud Firestore collections from `firebase-blueprint.json`,
 * the modular Phase 1 + Phase 2 file inventory, and the live `firestore.rules`.
 */

import React, { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { SchemaTableDoc } from '../types/database.ts';
import { PROJECT_MODULES, SCHEMA_TABLES } from '../lib/schemaDocs.ts';

export const SchemaExplorer: React.FC = () => {
  const [selectedCollection, setSelectedCollection] = useState<string>(SCHEMA_TABLES[0].name);
  const [activeArtifact, setActiveArtifact] = useState<'rules' | 'blueprint'>('rules');
  const [rulesText, setRulesText] = useState<string>('');
  const [blueprintText, setBlueprintText] = useState<string>('');
  const [tables, setTables] = useState<SchemaTableDoc[]>(SCHEMA_TABLES);
  const [loadingArtifacts, setLoadingArtifacts] = useState<boolean>(true);
  const [copiedArtifact, setCopiedArtifact] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    fetch('/api/schema')
      .then((res) => res.json())
      .then((data: { tables?: SchemaTableDoc[]; rules?: string; blueprint?: string }) => {
        if (!active) return;
        if (data.tables) setTables(data.tables);
        if (data.rules) setRulesText(data.rules);
        if (data.blueprint) setBlueprintText(data.blueprint);
      })
      .catch((err) => console.error('Failed to load Firestore schema artifacts:', err))
      .finally(() => {
        if (active) setLoadingArtifacts(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const currentCollection =
    tables.find((t) => t.name === selectedCollection) ?? tables[0];
  const displayedCode = activeArtifact === 'rules' ? rulesText : blueprintText;

  const handleCopyArtifact = async () => {
    if (!displayedCode) return;
    try {
      await navigator.clipboard.writeText(displayedCode);
      setCopiedArtifact(true);
      setTimeout(() => setCopiedArtifact(false), 1800);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  return (
    <div className="space-y-10">
      {/* Intro */}
      <section className="space-y-2">
        <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
          Google Firebase Architecture & Firestore Collections
        </h1>
        <p className="text-sm text-slate-600 max-w-3xl leading-relaxed">
          Document model powered by Cloud Firestore with real-time `onSnapshot` market streaming,
          zero-trust `firestore.rules` with PII isolation, Google Sign-In authentication, and `zingo-cli` shielded bet ingestion.
        </p>
      </section>

      {/* Firestore Collection Inspector */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="font-display text-lg font-semibold text-slate-900">
            Firestore Collections ({tables.length})
          </h2>
          <div className="flex flex-nowrap sm:flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto no-scrollbar max-w-full">
            {tables.map((table) => {
              const active = table.name === currentCollection.name;
              return (
                <button
                  key={table.name}
                  type="button"
                  onClick={() => setSelectedCollection(table.name)}
                  className={`min-h-[36px] px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {table.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 sm:px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-mono text-sm font-semibold text-slate-900">
                  /{currentCollection.name}
                </h3>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="text-xs text-slate-500">
                  {currentCollection.realtimeEnabled
                    ? 'Live onSnapshot Sync'
                    : 'Scoped Document Read'}
                </span>
              </div>
              <p className="text-xs text-slate-600">{currentCollection.purpose}</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-500">
                  <th className="py-2.5 px-4 sm:px-5">Field</th>
                  <th className="py-2.5 px-4">Firestore Type</th>
                  <th className="py-2.5 px-4">Rule Constraint</th>
                  <th className="py-2.5 px-4 sm:px-5">Purpose</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {currentCollection.columns.map((col) => (
                  <tr key={col.name} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 sm:px-5 font-mono font-medium text-slate-900 whitespace-nowrap">
                      {col.name}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-amber-800 whitespace-nowrap">
                      {col.type}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">
                      {col.constraints}
                    </td>
                    <td className="py-2.5 px-4 sm:px-5 text-slate-600 min-w-[200px]">{col.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Modular Project Structure */}
      <section className="space-y-4">
        <h2 className="font-display text-lg font-semibold text-slate-900">
          Implemented Module Map
        </h2>
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-500">
                  <th className="py-2.5 px-4 sm:px-5">File / Endpoint</th>
                  <th className="py-2.5 px-4">Responsibility</th>
                  <th className="py-2.5 px-4 sm:px-5 text-right">Phase</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {PROJECT_MODULES.map((mod) => (
                  <tr key={mod.path} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 sm:px-5 font-mono font-medium text-slate-900 whitespace-nowrap">
                      {mod.path}
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 min-w-[200px]">{mod.role}</td>
                    <td className="py-2.5 px-4 sm:px-5 text-right font-medium whitespace-nowrap text-emerald-700">
                      {mod.phase}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Rules & Blueprint Viewer */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setActiveArtifact('rules')}
              className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors cursor-pointer ${
                activeArtifact === 'rules'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              firestore.rules
            </button>
            <button
              type="button"
              onClick={() => setActiveArtifact('blueprint')}
              className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors cursor-pointer ${
                activeArtifact === 'blueprint'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              firebase-blueprint.json
            </button>
          </div>

          <button
            type="button"
            onClick={handleCopyArtifact}
            disabled={!displayedCode}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-colors cursor-pointer disabled:opacity-50"
          >
            {copiedArtifact ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy {activeArtifact === 'rules' ? 'Rules' : 'Blueprint'}</span>
              </>
            )}
          </button>
        </div>

        <div className="bg-slate-950 text-slate-200 rounded-xl border border-slate-800 overflow-hidden">
          {loadingArtifacts ? (
            <div className="p-5 text-xs font-mono text-slate-400">
              Loading Firebase schema artifacts...
            </div>
          ) : (
            <pre className="p-5 text-xs font-mono leading-relaxed overflow-x-auto max-h-[440px]">
              <code>{displayedCode}</code>
            </pre>
          )}
        </div>
      </section>
    </div>
  );
};
