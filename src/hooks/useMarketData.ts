import { useEffect, useState } from 'react';
import {
  isLiveCapable, loadEngineStatus, loadMarketData, loadOpportunities,
  type EngineStatus, type MarketData,
} from '../data/live';
import type { AISignal } from '../data/market';

const REFRESH_MS = 60_000;

export interface MarketState extends MarketData {
  loading: boolean;
}

const EMPTY: MarketState = { series: null, signals: [], live: false, loading: false };

/** Serie + señales del par/TF en pantalla, siempre desde el motor. */
export function useMarketData(symbol: string, tf: string): MarketState {
  const key = `${symbol}:${tf}`;
  // se guarda la clave junto al dato para descartar respuestas de otro par/TF
  const [state, setState] = useState<{ key: string; data: MarketState } | null>(null);

  useEffect(() => {
    if (!isLiveCapable(symbol, tf)) return;

    let alive = true;
    const refresh = () =>
      loadMarketData(symbol, tf).then((d) => {
        if (alive) setState({ key: `${symbol}:${tf}`, data: { ...d, loading: false } });
      });

    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, tf]);

  if (state?.key === key) return state.data;
  return isLiveCapable(symbol, tf) ? { ...EMPTY, loading: true } : EMPTY;
}

/** Oportunidades puntuadas por el motor (tabla inferior + panel IA). */
export function useOpportunities(): { signals: AISignal[]; live: boolean } {
  const [state, setState] = useState<{ signals: AISignal[]; live: boolean }>({
    signals: [],
    live: false,
  });

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      loadOpportunities().then((r) => {
        if (alive) setState(r);
      });
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return state;
}

/** Estado del motor para la barra superior. */
export function useEngineStatus(): {
  status: EngineStatus;
  lastRun: string | null;
} {
  const [state, setState] = useState<{ status: EngineStatus; lastRun: string | null }>({
    status: 'offline',
    lastRun: null,
  });

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      loadEngineStatus().then((r) => {
        if (alive) setState({ status: r.status, lastRun: r.lastRun });
      });
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return state;
}
