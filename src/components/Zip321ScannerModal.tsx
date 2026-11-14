/**
 * Zolymarket — ZIP-321 QR Code Scanner Overlay
 *
 * Allows users in the Market list view to scan a ZIP-321 payment URI,
 * bare Zcash shielded address (u1.../utest1.../zs1...), or room QR code
 * via live camera, QR image upload, or paste to join the matching room.
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
  where,
} from 'firebase/firestore';
import { OperationType, db, handleFirestoreError } from '../lib/firebase.ts';
import { buildZip321Uri, parseZip321Input, ParsedZip321Scan } from '../lib/zip321.ts';
import { MarketWithDetails, OutcomeSide } from '../types/database.ts';

export interface Zip321RoomPrefill {
  side?: OutcomeSide;
  amountZec?: number;
  returnAddr?: string;
}

interface Zip321ScannerModalProps {
  isOpen: boolean;
  markets: MarketWithDetails[];
  onClose: () => void;
  onJoinRoom: (marketId: string, prefill?: Zip321RoomPrefill) => void;
}

interface BarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
}

interface MatchedResolution {
  marketId: string;
  question: string;
  address?: string;
  parsed: ParsedZip321Scan;
}

export const Zip321ScannerModal: React.FC<Zip321ScannerModalProps> = ({
  isOpen,
  markets,
  onClose,
  onJoinRoom,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const joinTimerRef = useRef<number | null>(null);
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

  const clearTimers = useCallback(() => {
    if (joinTimerRef.current !== null) {
      window.clearTimeout(joinTimerRef.current);
      joinTimerRef.current = null;
    }
  }, []);

  const resolveMarketFromPayload = useCallback(
    async (rawPayload: string) => {
      if (resolvingRef.current) return;
      const trimmed = rawPayload.trim();
      if (!trimmed) {
        setScanError('Scan or paste a ZIP-321 URI (zcash:u1...) or shielded address.');
        return;
      }

      resolvingRef.current = true;
      setResolving(true);
      setScanError(null);

      try {
        const parsed = parseZip321Input(trimmed);

        // Allow plain market IDs / slugs as a convenience fallback
        const directIdMatch = markets.find(
          (m) => m.id === trimmed || m.slug.toLowerCase() === trimmed.toLowerCase()
        );

        let matchedMarketId: string | null = directIdMatch?.id ?? null;
        let matchedQuestion: string = directIdMatch?.question ?? '';

        if (!matchedMarketId && !parsed) {
          setScanError(
            'Unrecognized QR payload. Expected a ZIP-321 URI (zcash:u1...), Zcash shielded address, or room link.'
          );
          return;
        }

        if (!matchedMarketId && parsed) {
          // 1. Match by marketId extracted from ZIP-321 memo or room URL (exact, slug, or 8-char prefix)
          if (parsed.marketId) {
            const byId = markets.find(
              (m) =>
                m.id === parsed.marketId ||
                m.slug === parsed.marketId ||
                (parsed.marketId && m.id.startsWith(parsed.marketId))
            );
            if (byId) {
              matchedMarketId = byId.id;
              matchedQuestion = byId.question;
            }
          }

          // 2. Match by shielded pool address or creator unified address in loaded markets
          if (!matchedMarketId && parsed.address) {
            const needle = parsed.address.toLowerCase();
            const byPool = markets.find(
              (m) => m.shieldedPoolAddress.toLowerCase() === needle
            );
            if (byPool) {
              matchedMarketId = byPool.id;
              matchedQuestion = byPool.question;
            } else {
              const byCreator = markets.find(
                (m) => m.creator.zcashUnifiedAddress.toLowerCase() === needle
              );
              if (byCreator) {
                matchedMarketId = byCreator.id;
                matchedQuestion = byCreator.question;
              }
            }
          }

          // 3. Query Cloud Firestore directly if not matched in current memory slice
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
                  // Continue to address lookup fallback
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
                // Report unmatched cleanly below
              }
            }
          }
        }

        if (!matchedMarketId) {
          setScanError(
            parsed?.address
              ? `Valid ZIP-321 / Zcash address (${parsed.address.slice(0, 16)}...), but no active prediction market matches it.`
              : 'No prediction market matched the scanned QR code.'
          );
          return;
        }

        const effectiveParsed: ParsedZip321Scan = parsed ?? {
          kind: 'room_url',
          raw: trimmed,
          marketId: matchedMarketId,
        };

        stopCamera();
        setMatched({
          marketId: matchedMarketId,
          question: matchedQuestion || `Market ${matchedMarketId}`,
          address: effectiveParsed.address,
          parsed: effectiveParsed,
        });

        const prefill: Zip321RoomPrefill | undefined =
          effectiveParsed.pick || effectiveParsed.amountZec || effectiveParsed.returnAddr
            ? {
                side: effectiveParsed.pick,
                amountZec: effectiveParsed.amountZec,
                returnAddr: effectiveParsed.returnAddr,
              }
            : undefined;

        clearTimers();
        joinTimerRef.current = window.setTimeout(() => {
          onJoinRoom(matchedMarketId as string, prefill);
        }, 450);
      } finally {
        resolvingRef.current = false;
        setResolving(false);
      }
    },
    [markets, stopCamera, clearTimers, onJoinRoom]
  );

  const startCamera = useCallback(
    async (overrideDeviceId?: string, overrideFacing?: 'environment' | 'user') => {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
      ) {
        setCameraError('Camera access is unavailable in this browser context. Upload a QR image or paste a ZIP-321 URI below.');
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
            // Non-fatal if device enumeration fails
          }
        }
      } catch (err) {
        const msg =
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access or upload/paste a ZIP-321 QR code below.'
            : 'No live camera detected. Upload a QR image or paste a ZIP-321 URI below.';
        setCameraError(msg);
        setCameraActive(false);
      }
    },
    [facingMode, stopCamera]
  );

  // Start camera when modal opens, clean up on close/unmount
  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      clearTimers();
      setMatched(null);
      setScanError(null);
      return;
    }

    void startCamera();
    return () => {
      stopCamera();
      clearTimers();
    };
  }, [isOpen, startCamera, stopCamera, clearTimers]);

  // Escape key dismissal
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

  // Continuous QR frame decode loop while camera stream is active
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
              // Fall through to jsQR canvas decode
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="zip321-scanner-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <QrCode className="w-5 h-5 text-amber-700 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h2
                id="zip321-scanner-title"
                className="font-display text-base font-semibold text-slate-900 truncate"
              >
                Scan ZIP-321 Market QR
              </h2>
              <p className="text-xs text-slate-500 truncate">
                Point camera at a Zcash ZIP-321 QR code or shielded address to join directly
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

        {/* Camera / Upload Scanner Viewport */}
        <div className="p-5 space-y-5">
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

            {/* Viewfinder Corner Brackets when camera is streaming */}
            {cameraActive && !matched && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative w-52 h-52 sm:w-56 sm:h-56">
                  <span className="absolute top-0 left-0 w-7 h-7 border-t-2 border-l-2 border-amber-400 rounded-tl-md" />
                  <span className="absolute top-0 right-0 w-7 h-7 border-t-2 border-r-2 border-amber-400 rounded-tr-md" />
                  <span className="absolute bottom-0 left-0 w-7 h-7 border-b-2 border-l-2 border-amber-400 rounded-bl-md" />
                  <span className="absolute bottom-0 right-0 w-7 h-7 border-b-2 border-r-2 border-amber-400 rounded-br-md" />
                </div>
              </div>
            )}

            {/* Matched Success Overlay */}
            {matched && (
              <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center p-6 text-center space-y-3">
                <CheckCircle2 className="w-10 h-10 text-emerald-400" aria-hidden="true" />
                <div className="space-y-1 max-w-sm">
                  <p className="font-display text-base font-semibold text-white">
                    Market Room Matched
                  </p>
                  <p className="text-xs text-slate-300 line-clamp-2">{matched.question}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    clearTimers();
                    onJoinRoom(matched.marketId, {
                      side: matched.parsed.pick,
                      amountZec: matched.parsed.amountZec,
                      returnAddr: matched.parsed.returnAddr,
                    });
                  }}
                  className="min-h-[40px] px-4 py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors cursor-pointer"
                >
                  Open Room Now
                </button>
              </div>
            )}

            {/* Camera Unavailable / Idle Fallback */}
            {!cameraActive && !matched && (
              <div className="p-6 text-center space-y-3 max-w-xs">
                <Camera className="w-8 h-8 text-slate-400 mx-auto" aria-hidden="true" />
                <p className="text-xs text-slate-300 leading-relaxed">
                  {cameraError || 'Initializing camera stream for ZIP-321 QR scanning...'}
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
              Or paste ZIP-321 URI / Shielded Address (`zcash:u1...` or `u1...`)
            </label>
            <div className="flex items-stretch gap-2">
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
                {resolving ? 'Matching...' : 'Join Room'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
