/**
 * Zolymarket — Free Linux VPS `zingo-cli` Testnet `.env` Setup Guide
 *
 * Interactive step-by-step setup workflow tailored for free, minimal-setup
 * Ubuntu VPS hosts (Google Cloud Always Free e2-micro, Oracle Cloud Always Free,
 * and GitHub Codespaces) running Zcash Testnet with lightwalletd.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';

type VpsProviderId = 'gcp' | 'oracle' | 'codespaces';
type ZcashChain = 'testnet' | 'regtest' | 'mainnet';

interface ZingoStatusResponse {
  available: boolean;
  version: string | null;
  binary: string;
  chain: string;
  serverUri: string | null;
  dataDir: string | null;
  dataDirExists: boolean | null;
  error: string | null;
}

interface VpsProviderSpec {
  id: VpsProviderId;
  label: string;
  specs: string;
  summary: string;
  requiresSwap: boolean;
  cargoJobsFlag: string;
  provisionSteps: string[];
  step1CommandLabel: string;
  step1Command: string;
}

const DEFAULT_CONFIG = {
  cliBin: '/usr/local/bin/zingo-cli',
  chain: 'testnet' as ZcashChain,
  serverUri: 'https://testnet.zec.rocks:443',
  dataDir: '$HOME/.zolymarket/zingo-testnet',
};

const STORAGE_KEY_COMPLETED = 'zolymarket_zingo_setup_done_v1';
const STORAGE_KEY_VPS = 'zolymarket_zingo_vps_v1';

const VPS_PROVIDERS: Record<VpsProviderId, VpsProviderSpec> = {
  gcp: {
    id: 'gcp',
    label: 'GCP Always Free (e2-micro)',
    specs: 'Ubuntu 24.04 LTS · 1 GB RAM · 30 GB Standard Disk',
    summary:
      'Best zero-cost cloud VM for minimal setup. Because e2-micro has 1 GB RAM, Step 01 adds a 4 GB swapfile so Rust compiles zingo-cli without getting killed by OOM.',
    requiresSwap: true,
    cargoJobsFlag: ' -j 2',
    provisionSteps: [
      'Create a Google Cloud Compute Engine VM in us-west1, us-central1, or us-east1 (required for Always Free).',
      'Select Machine type: e2-micro (0.25–2 vCPU shared, 1 GB memory).',
      'Set Boot disk to Ubuntu 24.04 LTS, x86_64, 30 GB Standard Persistent Disk (do not pick Balanced or SSD).',
      'Click SSH in the browser console to open a shell immediately with zero local SSH key setup.',
    ],
    step1CommandLabel: 'Create 4 GB swapfile & verify memory',
    step1Command:
      "sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab && free -h",
  },
  oracle: {
    id: 'oracle',
    label: 'Oracle Cloud Always Free',
    specs: 'Ubuntu 24.04 ARM · 2 OCPU · 12 GB RAM',
    summary:
      'Fastest free-tier Rust compilation with plenty of memory and zero swap configuration required.',
    requiresSwap: false,
    cargoJobsFlag: '',
    provisionSteps: [
      'In Oracle Cloud Compute, launch an instance using Always Free Eligible shape VM.Standard.A1.Flex.',
      'Allocate 2 OCPUs and 12 GB RAM with Ubuntu 24.04 Minimal or Standard image.',
      'Connect via SSH using the private key downloaded during instance creation.',
    ],
    step1CommandLabel: 'Verify ARM CPU & 12 GB RAM headroom',
    step1Command: 'uname -m && nproc && free -h',
  },
  codespaces: {
    id: 'codespaces',
    label: 'GitHub Codespaces',
    specs: 'Ubuntu Linux · 2 Cores · 8 GB RAM · Browser Shell',
    summary:
      'Zero cloud billing or VM provisioning—launches a ready Ubuntu terminal directly in your browser.',
    requiresSwap: false,
    cargoJobsFlag: '',
    provisionSteps: [
      'Open github.com/codespaces and start a Blank template (or open your Zolymarket repo in a Codespace).',
      'The free GitHub tier includes 60 hours/month on a 2-core, 8 GB RAM Ubuntu container.',
      'Run the commands below directly inside the Codespace terminal.',
    ],
    step1CommandLabel: 'Check Ubuntu container resources',
    step1Command: 'uname -a && nproc && free -h',
  },
};

function quoteBashArg(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '""';
  // Keep $HOME expandable in double quotes when present; escape other special chars
  const escaped = trimmed.replace(/(["`\\])/g, '\\$1');
  return `"${escaped}"`;
}

export const ZingoSetupGuide: React.FC = () => {
  const [vpsId, setVpsId] = useState<VpsProviderId>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_VPS);
      if (saved === 'gcp' || saved === 'oracle' || saved === 'codespaces') {
        return saved;
      }
    } catch {
      // Ignore storage failures
    }
    return 'gcp';
  });

  const [cliBin, setCliBin] = useState<string>(DEFAULT_CONFIG.cliBin);
  const [chain, setChain] = useState<ZcashChain>(DEFAULT_CONFIG.chain);
  const [serverUri, setServerUri] = useState<string>(DEFAULT_CONFIG.serverUri);
  const [dataDir, setDataDir] = useState<string>(DEFAULT_CONFIG.dataDir);

  const [completedSteps, setCompletedSteps] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_COMPLETED);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(false);
  const [cliStatus, setCliStatus] = useState<ZingoStatusResponse | null>(null);
  const [statusFetchError, setStatusFetchError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_VPS, vpsId);
    } catch {
      // Ignore storage failures
    }
  }, [vpsId]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_COMPLETED, JSON.stringify(completedSteps));
    } catch {
      // Ignore storage failures
    }
  }, [completedSteps]);

  const vps = VPS_PROVIDERS[vpsId];

  const handleChainChange = (nextChain: ZcashChain) => {
    setChain(nextChain);
    if (nextChain === 'testnet') {
      setServerUri('https://testnet.zec.rocks:443');
      if (dataDir.includes('regtest') || dataDir.includes('mainnet')) {
        setDataDir('$HOME/.zolymarket/zingo-testnet');
      }
    } else if (nextChain === 'regtest') {
      setServerUri('http://127.0.0.1:9067');
      if (dataDir.includes('testnet') || dataDir.includes('mainnet')) {
        setDataDir('$HOME/.zolymarket/zingo-regtest');
      }
    } else {
      setServerUri('https://mainnet.zec.rocks:443');
      if (dataDir.includes('testnet') || dataDir.includes('regtest')) {
        setDataDir('$HOME/.zolymarket/zingo-mainnet');
      }
    }
  };

  const handleResetDefaults = () => {
    setCliBin(DEFAULT_CONFIG.cliBin);
    setChain(DEFAULT_CONFIG.chain);
    setServerUri(DEFAULT_CONFIG.serverUri);
    setDataDir(DEFAULT_CONFIG.dataDir);
  };

  const toggleStep = (stepId: string) => {
    setCompletedSteps((prev) => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  const copyText = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const checkReadiness = async () => {
    setStatusLoading(true);
    setStatusFetchError(null);
    try {
      const response = await fetch('/api/zcash/status');
      const data = (await response.json()) as ZingoStatusResponse;
      setCliStatus(data);
    } catch (err) {
      setStatusFetchError(
        err instanceof Error ? err.message : 'Unable to reach /api/zcash/status.'
      );
    } finally {
      setStatusLoading(false);
    }
  };

  const effectiveBin = cliBin.trim() || 'zingo-cli';
  const effectiveServer = serverUri.trim();
  const effectiveDataDir = dataDir.trim() || '$HOME/.zolymarket/zingo-testnet';

  const zingoBaseInvocation = useMemo(() => {
    const parts = [quoteBashArg(effectiveBin), `--chain ${chain}`];
    if (effectiveServer) {
      parts.push(`--server ${quoteBashArg(effectiveServer)}`);
    }
    if (effectiveDataDir) {
      parts.push(`--data-dir ${quoteBashArg(effectiveDataDir)}`);
    }
    return parts.join(' ');
  }, [effectiveBin, chain, effectiveServer, effectiveDataDir]);

  const step2Command =
    'sudo apt-get update && sudo apt-get install -y build-essential gcc pkg-config libssl-dev libsqlite3-dev protobuf-compiler cmake git curl && curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source "$HOME/.cargo/env"';

  const installPrefix = effectiveBin.startsWith('/usr/') ? 'sudo ' : '';
  const step3Command = `git clone --depth 1 https://github.com/zingolabs/zingolib.git ~/zingolib && cd ~/zingolib && cargo build --release --package zingo-cli${vps.cargoJobsFlag} && ${installPrefix}install -Dm755 target/release/zingo-cli ${quoteBashArg(effectiveBin)} && ${quoteBashArg(effectiveBin)} --version`;

  const step4Command = `mkdir -p ${quoteBashArg(effectiveDataDir)} && chmod 700 ${quoteBashArg(effectiveDataDir)} && ${zingoBaseInvocation} addresses && ${zingoBaseInvocation} exportufvk`;

  const step5Command = `${zingoBaseInvocation} sync && ${zingoBaseInvocation} notes`;

  const envBlock = useMemo(() => {
    const lines = [
      `ZINGO_CLI_BIN="${effectiveBin}"`,
      `ZINGO_CHAIN="${chain}"`,
      `ZINGO_SERVER_URI="${effectiveServer}"`,
      `ZINGO_DATA_DIR="${effectiveDataDir}"`,
    ];
    return lines.join('\n');
  }, [effectiveBin, chain, effectiveServer, effectiveDataDir]);

  const stepIds = ['01', '02', '03', '04', '05', '06'];
  const completedCount = stepIds.filter((id) => completedSteps[id]).length;

  return (
    <div className="space-y-8">
      {/* Header & Progress Summary */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-6 border-b border-slate-200">
        <div className="space-y-2 max-w-2xl">
          <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
            Free Linux VPS setup for zingo-cli (.env)
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            Configure Zcash Testnet with lightwalletd on a zero-cost Ubuntu VPS, build{' '}
            <code className="font-mono text-xs text-slate-800">zingo-cli</code> cleanly, and
            generate the four environment variables used by Zolymarket&apos;s backend.
          </p>
        </div>

        <div className="flex items-center gap-6 shrink-0">
          <div className="font-mono tabular-nums text-right">
            <p className="font-sans text-xs text-slate-500">Checklist Progress</p>
            <p className="text-lg font-semibold text-slate-900">
              {completedCount} / {stepIds.length} steps
            </p>
          </div>
          {completedCount > 0 && (
            <button
              type="button"
              onClick={() => setCompletedSteps({})}
              className="px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:text-slate-900 hover:border-slate-300 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Clear Checks
            </button>
          )}
        </div>
      </section>

      {/* Host Profile Selector & Live .env Inputs */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Free VPS Host Selector */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-semibold text-slate-900">
              Choose your free Ubuntu VPS
            </h2>
            <p className="text-xs text-slate-500">
              Commands below automatically adjust memory flags and swap steps for your host.
            </p>
          </div>

          <div
            role="tablist"
            aria-label="Free VPS host selector"
            className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
          >
            {(Object.keys(VPS_PROVIDERS) as VpsProviderId[]).map((id) => {
              const item = VPS_PROVIDERS[id];
              const isActive = vpsId === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setVpsId(id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-2">
            <p className="text-xs font-mono text-amber-700">{vps.specs}</p>
            <p className="text-sm text-slate-600 leading-relaxed">{vps.summary}</p>
          </div>
        </div>

        {/* Right: Editable Environment Parameters */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <h2 className="font-display text-base font-semibold text-slate-900">
                Customize .env path & network
              </h2>
              <p className="text-xs text-slate-500">
                Edits update every command and the final .env file live.
              </p>
            </div>
            <button
              type="button"
              onClick={handleResetDefaults}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Reset Defaults</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <label className="block space-y-1">
              <span className="block text-xs font-mono font-medium text-slate-700">
                ZINGO_CLI_BIN
              </span>
              <input
                type="text"
                value={cliBin}
                onChange={(e) => setCliBin(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              />
            </label>

            <div className="space-y-1">
              <span className="block text-xs font-mono font-medium text-slate-700">
                ZINGO_CHAIN
              </span>
              <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
                {(['testnet', 'regtest', 'mainnet'] as ZcashChain[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => handleChainChange(c)}
                    className={`py-1.5 text-xs font-mono font-medium rounded-md transition-colors duration-150 whitespace-nowrap cursor-pointer ${
                      chain === c
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <label className="block space-y-1">
              <span className="block text-xs font-mono font-medium text-slate-700">
                ZINGO_SERVER_URI
              </span>
              <input
                type="text"
                value={serverUri}
                onChange={(e) => setServerUri(e.target.value)}
                placeholder="https://testnet.zec.rocks:443"
                className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              />
            </label>

            <label className="block space-y-1">
              <span className="block text-xs font-mono font-medium text-slate-700">
                ZINGO_DATA_DIR
              </span>
              <input
                type="text"
                value={dataDir}
                onChange={(e) => setDataDir(e.target.value)}
                placeholder="$HOME/.zolymarket/zingo-testnet"
                className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
              />
            </label>
          </div>

          <p className="text-xs text-slate-500">
            Note: In your server&apos;s actual <code className="font-mono">.env</code> file, replace{' '}
            <code className="font-mono">$HOME</code> with your absolute home path (e.g.{' '}
            <code className="font-mono">/home/ubuntu/.zolymarket/zingo-testnet</code>) because dotenv
            does not expand shell variables automatically.
          </p>
        </div>
      </section>

      {/* Step-by-Step Guide: 01 - 06 */}
      <section className="space-y-4">
        {/* Step 01 */}
        <StepBlock
          stepNumber="01"
          title={`Provision ${vps.label}${vps.requiresSwap ? ' & Add 4 GB Swap' : ''}`}
          completed={Boolean(completedSteps['01'])}
          onToggleComplete={() => toggleStep('01')}
          commandId="step-01"
          commandLabel={vps.step1CommandLabel}
          command={vps.step1Command}
          copiedId={copiedId}
          onCopy={copyText}
        >
          <ol className="list-decimal list-inside space-y-1.5 text-sm text-slate-600 leading-relaxed">
            {vps.provisionSteps.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ol>
        </StepBlock>

        {/* Step 02 */}
        <StepBlock
          stepNumber="02"
          title="Install Build Dependencies & Rust Toolchain (1 Command)"
          completed={Boolean(completedSteps['02'])}
          onToggleComplete={() => toggleStep('02')}
          commandId="step-02"
          commandLabel="Install Ubuntu build tools + rustup"
          command={step2Command}
          copiedId={copiedId}
          onCopy={copyText}
        >
          <p className="text-sm text-slate-600 leading-relaxed">
            Zingo Labs distributes <code className="font-mono text-xs text-slate-800">zingo-cli</code>{' '}
            as Rust source rather than standalone prebuilt Linux binaries. Run this single command to
            install OpenSSL, SQLite, Protobuf, CMake, and Rust non-interactively.
          </p>
        </StepBlock>

        {/* Step 03 */}
        <StepBlock
          stepNumber="03"
          title="Compile & Install zingo-cli to ZINGO_CLI_BIN"
          completed={Boolean(completedSteps['03'])}
          onToggleComplete={() => toggleStep('03')}
          commandId="step-03"
          commandLabel={`Build release binary & install to ${effectiveBin}`}
          command={step3Command}
          copiedId={copiedId}
          onCopy={copyText}
        >
          <p className="text-sm text-slate-600 leading-relaxed">
            Compiles <code className="font-mono text-xs text-slate-800">zingo-cli</code> from{' '}
            <code className="font-mono text-xs text-slate-800">zingolabs/zingolib</code> and
            installs it directly to your configured{' '}
            <code className="font-mono text-xs text-slate-800">ZINGO_CLI_BIN</code> path (
            {vps.requiresSwap
              ? 'capped at -j 2 parallel jobs to keep e2-micro memory stable'
              : 'using full CPU concurrency'}
            ). Expect 8–15 minutes for the initial compile.
          </p>
        </StepBlock>

        {/* Step 04 */}
        <StepBlock
          stepNumber="04"
          title="Initialize ZINGO_DATA_DIR & Verify Unified Keys"
          completed={Boolean(completedSteps['04'])}
          onToggleComplete={() => toggleStep('04')}
          commandId="step-04"
          commandLabel="Create chmod-700 wallet directory & inspect address + UFVK"
          command={step4Command}
          copiedId={copiedId}
          onCopy={copyText}
        >
          <p className="text-sm text-slate-600 leading-relaxed">
            Creates your isolated wallet folder with strict owner-only permissions (
            <code className="font-mono text-xs text-slate-800">chmod 700</code>), connects to{' '}
            <code className="font-mono text-xs text-slate-800">{effectiveServer || 'local node'}</code>,
            initializes <code className="font-mono text-xs text-slate-800">zingo-wallet.dat</code>{' '}
            inside <code className="font-mono text-xs text-slate-800">ZINGO_DATA_DIR</code>, and
            prints your Unified Address (<code className="font-mono text-xs text-slate-800">utest1...</code>)
            and Unified Full Viewing Key (<code className="font-mono text-xs text-slate-800">uviewtest1...</code>).
            Your 24-word seed stays inside the wallet file and never goes into <code className="font-mono text-xs">.env</code>.
          </p>
        </StepBlock>

        {/* Step 05 */}
        <StepBlock
          stepNumber="05"
          title="Fund with Free Testnet ZEC (TAZ) & Verify Note Scanning"
          completed={Boolean(completedSteps['05'])}
          onToggleComplete={() => toggleStep('05')}
          commandId="step-05"
          commandLabel="Sync lightwalletd blocks & list unspent Orchard/Sapling notes"
          command={step5Command}
          copiedId={copiedId}
          onCopy={copyText}
        >
          <p className="text-sm text-slate-600 leading-relaxed">
            Send free Testnet ZEC (TAZ) from a Zcash Testnet faucet to the{' '}
            <code className="font-mono text-xs text-slate-800">utest1...</code> address returned in
            Step 04. After 1–2 confirmations, run <code className="font-mono text-xs text-slate-800">notes</code>{' '}
            to verify the JSON structure (<code className="font-mono text-xs text-slate-800">unspent_orchard_notes</code>)
            that Zolymarket&apos;s <code className="font-mono text-xs text-slate-800">pollMempoolForBets()</code> reads.
          </p>
        </StepBlock>

        {/* Step 06: Generated .env + Live Server Readiness Check */}
        <article className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                06. Copy Generated .env &amp; Test Server Readiness
              </h2>
              <p className="text-sm text-slate-600">
                Paste these variables into the <code className="font-mono text-xs">.env</code> file
                in your Zolymarket project root on the VPS, then run the readiness check.
              </p>
            </div>

            <button
              type="button"
              onClick={() => toggleStep('06')}
              aria-pressed={Boolean(completedSteps['06'])}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer ${
                completedSteps['06']
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:text-slate-900 hover:border-slate-300'
              }`}
            >
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{completedSteps['06'] ? 'Completed' : 'Mark Done'}</span>
            </button>
          </div>

          {/* Complete .env block */}
          <div className="bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-slate-400">
                .env (Zcash / zingo-cli variables)
              </span>
              <button
                type="button"
                onClick={() => void copyText('env-block', envBlock)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedId === 'env-block' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copy .env</span>
                  </>
                )}
              </button>
            </div>
            <pre className="p-4 text-xs font-mono text-slate-100 leading-relaxed overflow-x-auto">
              <code>{envBlock}</code>
            </pre>
          </div>

          {/* Live Diagnostic Endpoint Check */}
          <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-900">
                Backend Environment Diagnostic
              </p>
              <p className="text-xs text-slate-500">
                Queries <code className="font-mono">GET /api/zcash/status</code> on the running
                Express server to verify binary reachability and active flags.
              </p>
            </div>

            <button
              type="button"
              onClick={() => void checkReadiness()}
              disabled={statusLoading}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{statusLoading ? 'Checking Server...' : 'Test CLI Readiness'}</span>
            </button>
          </div>

          {statusFetchError && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{statusFetchError}</span>
            </div>
          )}

          {cliStatus && (
            <div
              className={`p-4 rounded-lg border text-xs space-y-3 ${
                cliStatus.available
                  ? 'bg-emerald-50/70 border-emerald-200 text-slate-800'
                  : 'bg-amber-50/70 border-amber-200 text-slate-800'
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                {cliStatus.available ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                    <span className="text-emerald-900">
                      Ready: zingo-cli detected ({cliStatus.version})
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
                    <span className="text-amber-900">
                      Not detected on current server host: {cliStatus.error}
                    </span>
                  </>
                )}
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-slate-200/70 font-mono">
                <div>
                  <dt className="font-sans text-slate-500">Active Binary</dt>
                  <dd className="text-slate-900 truncate" title={cliStatus.binary}>
                    {cliStatus.binary}
                  </dd>
                </div>
                <div>
                  <dt className="font-sans text-slate-500">Active Chain</dt>
                  <dd className="text-slate-900">{cliStatus.chain}</dd>
                </div>
                <div>
                  <dt className="font-sans text-slate-500">Server URI</dt>
                  <dd className="text-slate-900 truncate" title={cliStatus.serverUri ?? 'unset'}>
                    {cliStatus.serverUri ?? 'Unset'}
                  </dd>
                </div>
                <div>
                  <dt className="font-sans text-slate-500">Data Dir</dt>
                  <dd className="text-slate-900 truncate" title={cliStatus.dataDir ?? 'default'}>
                    {cliStatus.dataDir
                      ? `${cliStatus.dataDir} (${cliStatus.dataDirExists ? 'exists' : 'missing'})`
                      : 'Default (~/.zcash)'}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </article>
      </section>
    </div>
  );
};

interface StepBlockProps {
  stepNumber: string;
  title: string;
  completed: boolean;
  onToggleComplete: () => void;
  commandId: string;
  commandLabel: string;
  command: string;
  copiedId: string | null;
  onCopy: (id: string, value: string) => Promise<void>;
  children: React.ReactNode;
}

const StepBlock: React.FC<StepBlockProps> = ({
  stepNumber,
  title,
  completed,
  onToggleComplete,
  commandId,
  commandLabel,
  command,
  copiedId,
  onCopy,
  children,
}) => {
  const isCopied = copiedId === commandId;

  return (
    <article className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5 max-w-3xl">
          <h2 className="font-display text-lg font-semibold text-slate-900">
            {stepNumber}. {title}
          </h2>
          <div>{children}</div>
        </div>

        <button
          type="button"
          onClick={onToggleComplete}
          aria-pressed={completed}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer ${
            completed
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-white text-slate-600 border-slate-200 hover:text-slate-900 hover:border-slate-300'
          }`}
        >
          <Check className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{completed ? 'Completed' : 'Mark Done'}</span>
        </button>
      </div>

      <div className="bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
        <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between gap-3">
          <span className="text-xs font-mono text-slate-400 truncate">{commandLabel}</span>
          <button
            type="button"
            onClick={() => void onCopy(commandId, command)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isCopied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        <pre className="p-4 text-xs font-mono text-slate-100 leading-relaxed overflow-x-auto">
          <code>{command}</code>
        </pre>
      </div>
    </article>
  );
};
