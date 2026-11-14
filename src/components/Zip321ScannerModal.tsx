/**
 * Zolymarket — Scan-to-Upload & Scan-to-Checkout QR Modal
 *
 * Allows users to scan a Zcash ZIP-321 QR, Polygon EIP-681 URI, JSON bet ticket,
 * shielded address, or room URL via live camera, QR image upload, or paste.
 * Automatically extracts every field (`marketId`, `pick`, `amount`, `payout_to`,
 * `poolAddress`, `txid`), saves return info, uploads bet/position data, and
 * launches directly into checkout.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  QrCode,
  RefreshCw,
  SwitchCamera,
  Upload,
  X,
} from 'lucide-react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext.tsx';
import { estimateSharesOut, zecToZatoshis } from '../lib/cpmm.ts';
import { OperationType, db, handleFirestoreError } from '../lib/firebase.ts';
import { buildZip321Uri, parseZip321Input, ParsedZip321Scan, utf8ToHex } from '../lib/zip321.ts';
import { MarketWithDetails, OutcomeSide } from '../types/database.ts';

export interface Zip321RoomPrefill {
  side?: OutcomeSide;
  amountZec?: number;
  returnAddr?: string;
  rail?: 'zcash' | 'pollar';
  txid?: string;
  scannedAt?: string;
  uploaded?: boolean;
}

interface Zip321ScannerModalProps {
  isOpen: boolean;
  markets: MarketWithDetails[];
  onClose: () => void;
  onJoinRoom: (marketId: string, prefill?: Zip321RoomPrefill) => void;
  onBetUploaded?: () => void;
}

interface BarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
}

interface MatchedResolution {
  marketId: string;
  question: string;
  market?: MarketWithDetails;
  address?: string;
  parsed: ParsedZip321Scan;
}

function generatePreviewHexTxid(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const Zip321ScannerModal: React.FC<Zip321ScannerModalProps> = ({
  isOpen,
  markets,
  onClose,
  onJoinRoom,
  onBetUploaded,
}) => {
  const { user, walletSession, connectZcashWallet, connectPolygonAddress } = useAuth();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const resolvingRef = useRef<boolean>(false);

  const [cameraActive, setCameraActive] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  const [manualInput, setManualInput] = useState<string>('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<boolean>(false);
  const [matched, setMatched] = useState<MatchedResolution | null>(null);

  // Editable extracted fields so scanned bet payload uploads completely before checkout
  const [extractedPick, setExtractedPick] = useState<OutcomeSide>(OutcomeSide.Yes);
  const [extractedAmount, setExtractedAmount] = useState<string>('0.5');
  const [extractedReturnAddr, setExtractedReturnAddr] = useState<string>('');
  const [extractedTxid, setExtractedTxid] = useState<string>('');
  const [extractedRail, setExtractedRail] = useState<'zcash' | 'pollar'>('zcash');
  const [uploadingCheckout, setUploadingCheckout] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  const resolveMarketFromPayload = useCallback(
    async (rawPayload: string) => {
      if (resolvingRef.current) return;
      const trimmed = rawPayload.trim();
      if (!trimmed) {
        setScanError('Scan or paste a ZIP-321 URI (zcash:u1...), Polygon URI, or shielded address.');
        return;
      }

      resolvingRef.current = true;
      setResolving(true);
      setScanError(null);
      setUploadError(null);

      try {
        const parsed = parseZip321Input(trimmed);

        const directIdMatch = markets.find(
          (m) => m.id === trimmed || m.slug.toLowerCase() === trimmed.toLowerCase()
        );

        let matchedMarket: MarketWithDetails | undefined = directIdMatch;
        let matchedMarketId: string | null = directIdMatch?.id ?? null;
        let matchedQuestion: string = directIdMatch?.question ?? '';

        if (!matchedMarketId && !parsed) {
          setScanError(
            'Unrecognized QR payload. Expected a ZIP-321 URI (zcash:u1...), Polygon URI, JSON bet ticket, or room link.'
          );
          return;
        }

        if (!matchedMarketId && parsed) {
          if (parsed.marketId) {
            const byId = markets.find(
              (m) =>
                m.id === parsed.marketId ||
                m.slug === parsed.marketId ||
                (parsed.marketId && m.id.startsWith(parsed.marketId))
            );
            if (byId) {
              matchedMarket = byId;
              matchedMarketId = byId.id;
              matchedQuestion = byId.question;
            }
          }

          if (!matchedMarketId && parsed.address) {
            const needle = parsed.address.toLowerCase();
            const byPool = markets.find(
              (m) => m.shieldedPoolAddress.toLowerCase() === needle
            );
            if (byPool) {
              matchedMarket = byPool;
              matchedMarketId = byPool.id;
              matchedQuestion = byPool.question;
            } else {
              const byCreator = markets.find(
                (m) => m.creator.zcashUnifiedAddress.toLowerCase() === needle
              );
              if (byCreator) {
                matchedMarket = byCreator;
                matchedMarketId = byCreator.id;
                matchedQuestion = byCreator.question;
              }
            }
          }

          if (!matchedMarketId && parsed.marketId) {
            const targetId = parsed.marketId;
            if (/^[a-zA-Z0-9_-]{1,128}$/.test(targetId)) {
              try {
                const snap = await getDoc(doc(db, 'markets', targetId));
                if (snap.exists()) {
                  const data = snap.data();
                  matchedMarketId = String(data.id || snap.id);
                  matchedQuestion = String(data.question || matchedMarketId);
                }
              } catch (err) {
                try {
                  handleFirestoreError(err, OperationType.GET, `markets/${targetId}`);
                } catch {
                  // Continue fallback
                }
              }
            }
          }

          if (!matchedMarketId && parsed.address) {
            try {
              const addrQuery = query(
                collection(db, 'markets'),
                where('shieldedPoolAddress', '==', parsed.address),
                limit(1)
              );
              const snap = await getDocs(addrQuery);
              if (!snap.empty) {
                const docSnap = snap.docs[0];
                const data = docSnap.data();
                matchedMarketId = String(data.id || docSnap.id);
                matchedQuestion = String(data.question || matchedMarketId);
              }
            } catch (err) {
              try {
                handleFirestoreError(err, OperationType.LIST, 'markets');
              } catch {
                // Report unmatched below
              }
            }
          }

          // Fallback to first open market when scanning a bare Polygon 0x address / user wallet QR
          if (!matchedMarketId && (parsed.kind === 'polygon_address' || parsed.kind === 'polygon_uri')) {
            const fallbackMarket = markets.find((m) => m.status === 'open') ?? markets[0];
            if (fallbackMarket) {
              matchedMarket = fallbackMarket;
              matchedMarketId = fallbackMarket.id;
              matchedQuestion = fallbackMarket.question;
            }
          }
        }

        if (!matchedMarketId) {
          setScanError(
            parsed?.address
              ? `Valid address (${parsed.address.slice(0, 16)}...), but no active prediction market matches it.`
              : 'No prediction market matched the scanned QR code.'
          );
          return;
        }

        const effectiveParsed: ParsedZip321Scan = parsed ?? {
          kind: 'room_url',
          raw: trimmed,
          marketId: matchedMarketId,
        };

        const defaultReturn = (() => {
          if (effectiveParsed.returnAddr) return effectiveParsed.returnAddr;
          if (walletSession?.address) return walletSession.address;
          try {
            return localStorage.getItem('zolymarket_player_return_addr_v1') || '';
          } catch {
            return '';
          }
        })();

        const resolvedRail: 'zcash' | 'pollar' =
          effectiveParsed.rail === 'polygon' || walletSession?.rail === 'polygon'
            ? 'pollar'
            : 'zcash';

        stopCamera();
        setExtractedPick(effectiveParsed.pick ?? OutcomeSide.Yes);
        setExtractedAmount(
          String(effectiveParsed.amountZec ?? effectiveParsed.amountToken ?? 0.5)
        );
        setExtractedReturnAddr(defaultReturn);
        setExtractedTxid(effectiveParsed.txid ?? '');
        setExtractedRail(resolvedRail);

        setMatched({
          marketId: matchedMarketId,
          question: matchedQuestion || `Market ${matchedMarketId}`,
          market: matchedMarket,
          address: effectiveParsed.address ?? matchedMarket?.shieldedPoolAddress,
          parsed: effectiveParsed,
        });
      } finally {
        resolvingRef.current = false;
        setResolving(false);
      }
    },
    [markets, stopCamera, walletSession]
  );

  const handleUploadAndCheckout = async () => {
    if (!matched) return;
    setUploadError(null);
    setUploadingCheckout(true);

    try {
      const parsedAmt = Number.parseFloat(extractedAmount);
      const safeAmt = Number.isFinite(parsedAmt) && parsedAmt > 0 ? parsedAmt : 0.5;
      const cleanReturn = extractedReturnAddr.trim();
      const cleanTxid = extractedTxid.trim();

      // 1. Persist return address & link wallet identity if valid
      if (cleanReturn) {
        try {
          if (/^(u1|utest1|uregtest1|zs1)[0-9a-zA-Z]{16,252}$/.test(cleanReturn)) {
            localStorage.setItem('zolymarket_player_return_addr_v1', cleanReturn);
            if (!walletSession) {
              connectZcashWallet(cleanReturn, 'Scanned Zcash Wallet');
            }
          } else if (/^0x[a-fA-F0-9]{40}$/.test(cleanReturn) && !walletSession) {
            connectPolygonAddress(cleanReturn, 'Scanned Polygon Wallet');
          }
        } catch {
          // Ignore non-fatal storage/session auto-link errors
        }
      }

      // 2. Persist scanned bet ticket history locally
      try {
        const key = 'zolymarket_scanned_checkouts_v1';
        const existing = JSON.parse(localStorage.getItem(key) || '[]') as unknown[];
        const nextEntry = {
          marketId: matched.marketId,
          pick: extractedPick,
          amount: safeAmt,
          rail: extractedRail,
          returnAddr: cleanReturn,
          txid: cleanTxid || null,
          scannedAt: new Date().toISOString(),
        };
        localStorage.setItem(key, JSON.stringify([nextEntry, ...existing].slice(0, 20)));
      } catch {
        // Ignore storage quota errors
      }

      // 3. Upload position record to Cloud Firestore `positions` when authenticated with Google
      const amountZatoshis = zecToZatoshis(safeAmt);
      if (user) {
        const posId = `pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        const yesPool = matched.market?.outcomes.yes.poolZatoshis ?? 500_000_000;
        const noPool = matched.market?.outcomes.no.poolZatoshis ?? 500_000_000;
        const quote = estimateSharesOut({
          amountZatoshis,
          targetPoolZatoshis: extractedPick === OutcomeSide.Yes ? yesPool : noPool,
          oppositePoolZatoshis: extractedPick === OutcomeSide.Yes ? noPool : yesPool,
          creatorFeeBps: matched.market?.creatorFeeBps ?? 150,
        });
        const commitmentSource = cleanTxid || cleanReturn || user.uid;
        const traderCommitment = commitmentSource.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'scan_bet';
        const validZcashPayout = /^(u1|utest1|uregtest1|zs1)[0-9a-zA-Z]{16,252}$/.test(cleanReturn);

        try {
          await setDoc(doc(db, 'positions', posId), {
            id: posId,
            marketId: matched.marketId,
            ownerUid: user.uid,
            side: extractedPick,
            traderCommitment,
            ...(validZcashPayout ? { payoutAddress: cleanReturn } : {}),
            shares: Math.max(0.0001, quote.sharesOut),
            costBasisZatoshis: amountZatoshis,
            claimed: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          try {
            handleFirestoreError(err, OperationType.CREATE, `positions/${posId}`);
          } catch {
            // Do not block checkout room entry if optional position upload requires verification
          }
        }
      }

      // 4. Upload verified bet payload to Express `/api/markets/:id/bets` when txid is provided
      let uploadedToLedger = false;
      if (cleanTxid && /^[0-9a-fA-F]{16,128}$/.test(cleanTxid)) {
        const recipientAddr =
          matched.address ||
          matched.market?.shieldedPoolAddress ||
          'utest1placeholder000000000000000000000000';
        const payoutTarget = cleanReturn || recipientAddr;
        const memoHex = utf8ToHex(
          JSON.stringify({
            q: matched.marketId,
            pick: extractedPick,
            payout_to: payoutTarget,
          })
        ).slice(0, 1024);

        const res = await fetch(`/api/markets/${encodeURIComponent(matched.marketId)}/bets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txid: cleanTxid,
            poolType: 'orchard',
            recipientAddress: recipientAddr,
            pick: extractedPick,
            payoutTo: payoutTarget,
            amountZatoshis,
            rawMemoHex: memoHex,
            confirmations: 1,
          }),
        });
        if (res.ok) {
          uploadedToLedger = true;
          onBetUploaded?.();
        }
      }

      onJoinRoom(matched.marketId, {
        side: extractedPick,
        amountZec: safeAmt,
        returnAddr: cleanReturn || undefined,
        rail: extractedRail,
        txid: cleanTxid || undefined,
        scannedAt: new Date().toISOString(),
        uploaded: uploadedToLedger || Boolean(user),
      });
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Unable to upload scanned bet payload.'
      );
    } finally {
      setUploadingCheckout(false);
    }
  };

  const startCamera = useCallback(
    async (overrideDeviceId?: string, overrideFacing?: 'environment' | 'user') => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        setCameraError(
          'Camera access is unavailable in this browser context. Upload a QR image or paste a ZIP-321 / Polygon URI below.'
        );
        return;
      }

      stopCamera();
      setCameraError(null);

      try {
        const videoConstraint: MediaTrackConstraints = overrideDeviceId
          ? { deviceId: { exact: overrideDeviceId } }
          : { facingMode: { ideal: overrideFacing ?? facingMode } };

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraint,
          audio: false,
        });

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraActive(true);

        if (navigator.mediaDevices.enumerateDevices) {
          try {
            const allDevices = await navigator.mediaDevices.enumerateDevices();
            const videoInputs = allDevices.filter((d) => d.kind === 'videoinput');
            setCameras(videoInputs);
            const activeTrack = stream.getVideoTracks()[0];
            const activeId = activeTrack?.getSettings().deviceId;
            if (activeId) setSelectedDeviceId(activeId);
          } catch {
            // Non-fatal
          }
        }
      } catch (err) {
        const msg =
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access or upload/paste a bet QR below.'
            : 'No live camera detected. Upload a QR image or paste a bet QR payload below.';
        setCameraError(msg);
        setCameraActive(false);
      }
    },
    [facingMode, stopCamera]
  );

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      setMatched(null);
      setScanError(null);
      setUploadError(null);
      return;
    }

    void startCamera();
    return () => {
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !cameraActive || matched) return;

    let cancelled = false;
    let lastScanAt = 0;

    const DetectorCtor = (
      window as unknown as {
        BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
      }
    ).BarcodeDetector;
    const detector = DetectorCtor ? new DetectorCtor({ formats: ['qr_code'] }) : null;

    const scanFrame = async (timestamp: number) => {
      if (cancelled) return;

      if (timestamp - lastScanAt >= 120 && videoRef.current && videoRef.current.readyState >= 2) {
        lastScanAt = timestamp;
        const video = videoRef.current;
        const width = video.videoWidth;
        const height = video.videoHeight;

        if (width > 0 && height > 0) {
          let detectedText: string | null = null;

          if (detector) {
            try {
              const results = await detector.detect(video);
              const first = results.find((r) => Boolean(r.rawValue));
              if (first?.rawValue) {
                detectedText = first.rawValue;
              }
            } catch {
              // Fallback to jsQR
            }
          }

          if (!detectedText && canvasRef.current) {
            const canvas = canvasRef.current;
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, width, height);
              const imageData = ctx.getImageData(0, 0, width, height);
              const code = jsQR(imageData.data, width, height, {
                inversionAttempts: 'dontInvert',
              });
              if (code?.data) {
                detectedText = code.data;
              }
            }
          }

          if (detectedText && !cancelled) {
            setManualInput(detectedText);
            void resolveMarketFromPayload(detectedText);
            return;
          }
        }
      }

      if (!cancelled) {
        rafRef.current = requestAnimationFrame((ts) => {
          void scanFrame(ts);
        });
      }
    };

    rafRef.current = requestAnimationFrame((ts) => {
      void scanFrame(ts);
    });

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isOpen, cameraActive, matched, resolveMarketFromPayload]);

  const handleSwitchCamera = () => {
    if (cameras.length > 1) {
      const idx = cameras.findIndex((c) => c.deviceId === selectedDeviceId);
      const next = cameras[(idx + 1) % cameras.length];
      void startCamera(next.deviceId);
      return;
    }
    const nextFacing = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextFacing);
    void startCamera(undefined, nextFacing);
  };

  const handleImageUpload = async (file: File | null) => {
    if (!file) return;
    setScanError(null);
    setResolving(true);

    try {
      const imgUrl = URL.createObjectURL(file);
      try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Unable to read image file.'));
          img.src = imgUrl;
        });

        const canvas = canvasRef.current ?? document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          throw new Error('Canvas context unavailable for QR decoding.');
        }

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, canvas.width, canvas.height, {
          inversionAttempts: 'attemptBoth',
        });

        if (!code?.data) {
          setScanError('No QR code detected in the uploaded image. Try a clearer crop.');
          setResolving(false);
          return;
        }

        setManualInput(code.data);
        setResolving(false);
        await resolveMarketFromPayload(code.data);
      } finally {
        URL.revokeObjectURL(imgUrl);
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Failed to decode QR image.');
      setResolving(false);
    }
  };

  const handleUseSampleZip321 = () => {
    const sampleMarket = markets.find((m) => m.status === 'open') ?? markets[0];
    if (!sampleMarket) return;

    try {
      const generated = buildZip321Uri({
        address: sampleMarket.shieldedPoolAddress,
        amountZec: 0.5,
        marketId: sampleMarket.id,
        side: OutcomeSide.Yes,
        commitment: 'quick_scan_preview',
      });
      setManualInput(generated.uri);
      setScanError(null);
    } catch {
      setManualInput(sampleMarket.shieldedPoolAddress);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="zip321-scanner-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[92dvh] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-slate-200 flex items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <QrCode className="w-5 h-5 text-amber-700 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h2
                id="zip321-scanner-title"
                className="font-display text-base font-semibold text-slate-900 truncate"
              >
                Scan Bet QR · Upload &amp; Checkout
              </h2>
              <p className="text-xs text-slate-500 truncate">
                Scan a ZIP-321 or Polygon QR to extract all fields, upload, and check out
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close QR scanner"
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4 sm:space-y-5">
          {matched ? (
            /* Scanned Bet Extracted -> Review, Upload Everything & Proceed to Checkout */
            <div className="space-y-4">
              <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-semibold text-emerald-900">
                    Scanned Bet Extracted &amp; Ready for Checkout
                  </p>
                  <p className="text-sm font-medium text-slate-900 leading-snug">
                    {matched.question}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setExtractedPick(OutcomeSide.Yes)}
                  className={`min-h-[44px] py-2 px-3 rounded-lg border text-xs font-semibold cursor-pointer ${
                    extractedPick === OutcomeSide.Yes
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}
                >
                  Pick YES
                </button>
                <button
                  type="button"
                  onClick={() => setExtractedPick(OutcomeSide.No)}
                  className={`min-h-[44px] py-2 px-3 rounded-lg border text-xs font-semibold cursor-pointer ${
                    extractedPick === OutcomeSide.No
                      ? 'bg-rose-600 text-white border-rose-600'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}
                >
                  Pick NO
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-700">
                    Stake Amount ({extractedRail === 'zcash' ? 'ZEC' : 'USDC'})
                  </span>
                  <input
                    type="number"
                    step="0.0001"
                    min="0.0001"
                    value={extractedAmount}
                    onChange={(e) => setExtractedAmount(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                  />
                </label>

                <div className="space-y-1">
                  <span className="text-xs font-medium text-slate-700 block">
                    Checkout Rail
                  </span>
                  <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setExtractedRail('zcash')}
                      className={`min-h-[36px] text-xs font-semibold rounded-md cursor-pointer ${
                        extractedRail === 'zcash'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600'
                      }`}
                    >
                      Zcash ZEC
                    </button>
                    <button
                      type="button"
                      onClick={() => setExtractedRail('pollar')}
                      className={`min-h-[36px] text-xs font-semibold rounded-md cursor-pointer ${
                        extractedRail === 'pollar'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600'
                      }`}
                    >
                      Pollar / Polygon
                    </button>
                  </div>
                </div>
              </div>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">
                  Return Payout Address ({extractedRail === 'zcash' ? 'u1... / utest1...' : '0x... / u1...'})
                </span>
                <input
                  type="text"
                  value={extractedReturnAddr}
                  onChange={(e) => setExtractedReturnAddr(e.target.value)}
                  placeholder="u1... or utest1... or 0x..."
                  className="w-full min-h-[44px] px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                />
              </label>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="scanned-txid" className="text-xs font-medium text-slate-700">
                    Optional Paid TxID / Receipt Hash (Uploads Immediately)
                  </label>
                  <button
                    type="button"
                    onClick={() => setExtractedTxid(generatePreviewHexTxid())}
                    className="text-xs font-medium text-amber-700 hover:text-amber-800 cursor-pointer"
                  >
                    Generate Preview TxID
                  </button>
                </div>
                <input
                  id="scanned-txid"
                  type="text"
                  value={extractedTxid}
                  onChange={(e) => setExtractedTxid(e.target.value)}
                  placeholder="Leave blank to sign in Zashi / Polygon at next step"
                  className="w-full min-h-[44px] px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                />
              </div>

              {uploadError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800">
                  {uploadError}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2 pt-1">
                <button
                  type="button"
                  disabled={uploadingCheckout}
                  onClick={() => void handleUploadAndCheckout()}
                  className="flex-1 min-h-[48px] px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                >
                  {uploadingCheckout
                    ? 'Uploading Scanned Bet...'
                    : 'Upload Everything & Go to Checkout'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMatched(null);
                    setScanError(null);
                    void startCamera();
                  }}
                  className="min-h-[48px] px-4 py-2.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:border-slate-300 rounded-lg transition-colors cursor-pointer"
                >
                  Rescan
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className="relative aspect-[4/3] w-full bg-slate-950 rounded-xl overflow-hidden border border-slate-200 flex items-center justify-center"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const dropped = e.dataTransfer.files?.[0] ?? null;
                  void handleImageUpload(dropped);
                }}
              >
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${cameraActive ? 'block' : 'hidden'}`}
                />
                <canvas ref={canvasRef} className="hidden" />

                {cameraActive && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="relative w-52 h-52 sm:w-56 sm:h-56">
                      <span className="absolute top-0 left-0 w-7 h-7 border-t-2 border-l-2 border-amber-400 rounded-tl-md" />
                      <span className="absolute top-0 right-0 w-7 h-7 border-t-2 border-r-2 border-amber-400 rounded-tr-md" />
                      <span className="absolute bottom-0 left-0 w-7 h-7 border-b-2 border-l-2 border-amber-400 rounded-bl-md" />
                      <span className="absolute bottom-0 right-0 w-7 h-7 border-b-2 border-r-2 border-amber-400 rounded-br-md" />
                    </div>
                  </div>
                )}

                {!cameraActive && (
                  <div className="p-6 text-center space-y-3 max-w-xs">
                    <Camera className="w-8 h-8 text-slate-400 mx-auto" aria-hidden="true" />
                    <p className="text-xs text-slate-300 leading-relaxed">
                      {cameraError || 'Initializing camera stream for QR bet scanning...'}
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => void startCamera()}
                        className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-slate-900 bg-white hover:bg-slate-100 rounded-lg inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Retry Camera</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="min-h-[40px] px-3.5 py-2 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Upload QR Image</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Camera Controls Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 rounded-lg inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                  >
                    <Upload className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                    <span>Upload QR Image</span>
                  </button>

                  {cameraActive && (
                    <button
                      type="button"
                      onClick={handleSwitchCamera}
                      className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 rounded-lg inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <SwitchCamera className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                      <span>Switch Camera</span>
                    </button>
                  )}
                </div>

                {markets.length > 0 && (
                  <button
                    type="button"
                    onClick={handleUseSampleZip321}
                    className="min-h-[40px] px-3 py-2 text-xs font-medium text-amber-800 hover:text-amber-900 cursor-pointer whitespace-nowrap"
                  >
                    Insert Sample ZIP-321
                  </button>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const selected = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  void handleImageUpload(selected);
                }}
              />

              {scanError && (
                <div
                  role="alert"
                  className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg flex items-start gap-2.5 text-xs text-rose-800"
                >
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 space-y-1">
                    <p>{scanError}</p>
                    {!cameraActive && (
                      <button
                        type="button"
                        onClick={() => {
                          setScanError(null);
                          void startCamera();
                        }}
                        className="font-semibold underline hover:text-rose-950 cursor-pointer"
                      >
                        Scan another QR code
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Direct Paste Fallback */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void resolveMarketFromPayload(manualInput);
                }}
                className="pt-4 border-t border-slate-100 space-y-2"
              >
                <label
                  htmlFor="zip321-manual-input"
                  className="block text-xs font-medium text-slate-700"
                >
                  Or paste ZIP-321 URI, Polygon URI, or Shielded Address
                </label>
                <div className="flex flex-col min-[380px]:flex-row items-stretch gap-2">
                  <input
                    id="zip321-manual-input"
                    type="text"
                    value={manualInput}
                    onChange={(e) => {
                      setManualInput(e.target.value);
                      if (scanError) setScanError(null);
                    }}
                    placeholder="zcash:u1...?amount=0.5&memo=..."
                    className="flex-1 min-h-[44px] px-3.5 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:bg-white"
                  />
                  <button
                    type="submit"
                    disabled={resolving || !manualInput.trim()}
                    className="min-h-[44px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {resolving ? 'Extracting...' : 'Scan & Extract'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
