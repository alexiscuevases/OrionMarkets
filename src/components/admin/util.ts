import { useCallback, useEffect, useState } from 'react';

/* Utilidades compartidas del panel de administración. */

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Carga con recarga manual; el error queda como mensaje legible. */
export function useAdminFetch<T>(fetcher: () => Promise<T>): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  // loading arranca en true y cada reload lo re-arma desde el handler,
  // nunca desde el efecto (evita renders en cascada)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    setLoading(true);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    fetcher()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'error de red');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return { data, loading, error, reload };
}

const DT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit', month: '2-digit', year: '2-digit',
  hour: '2-digit', minute: '2-digit',
});

export function fmtTs(ts: number | null | undefined): string {
  return ts ? DT.format(new Date(ts)) : '—';
}

export function fmtDate(ts: number | null | undefined): string {
  return ts ? new Date(ts).toISOString().slice(0, 10) : '—';
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60}m`;
  return `${Math.floor(h / 24)} d`;
}

export function fmtMoney(v: number | null | undefined, decimals = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toLocaleString('es-ES', { maximumFractionDigits: 2 })}%`;
}

/** R con signo explícito: +3.2R / −1.0R. */
export function fmtR(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v > 0 ? '+' : '';
  return `${s}${v.toLocaleString('es-ES', { maximumFractionDigits: 2 })}R`;
}

/** winRate viene como fracción (0.62) del worker. */
export function fmtWinRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}
