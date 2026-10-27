import { useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface Props {
  onScan: (text: string) => void;
  onError: (message: string) => void;
}

/** Mount olanda arxa kameranı açır, unmount olanda bağlayır */
export default function QrScanner({ onScan, onError }: Props) {
  const elId = useRef(`reader-${Math.random().toString(36).slice(2)}`).current;
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  onScanRef.current = onScan;
  onErrorRef.current = onError;

  useEffect(() => {
    const scanner = new Html5Qrcode(elId, { verbose: false });
    let cancelled = false;
    const started = scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 230, height: 230 } },
        (text) => onScanRef.current(text),
        () => { /* kadrda QR yoxdur — normaldır */ },
      )
      .catch(() => {
        if (!cancelled) {
          onErrorRef.current('Kamera açılmadı. Brauzerə kamera icazəsi verin (sayt HTTPS və ya localhost olmalıdır).');
        }
      });

    return () => {
      cancelled = true;
      started
        .then(() => (scanner.isScanning ? scanner.stop() : undefined))
        .then(() => scanner.clear())
        .catch(() => { /* artıq bağlanıb */ });
    };
  }, [elId]);

  return <div id={elId} className="reader" />;
}
