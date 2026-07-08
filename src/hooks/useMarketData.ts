import { useEffect, useMemo, useState } from 'react';
import {
  isLiveCapable, loadEngineStatus, loadMarketData, loadOpportunities,
  loadStrategyStats, type EngineStatus, type MarketData,
} from '../data/live';
import type { AISignal } from '../data/market';
import {
  STRATEGY_DEFS, loadActiveIds, saveActiveIds,
  type Strategy, type StrategyStats,
} from '../data/strategies';

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

/** Catálogo de estrategias con rendimiento real del motor y estado
    activo persistido; solo las activas muestran señales en la UI. */
export function useStrategies(): {
  strategies: Strategy[];
  activeIds: Set<string>;
  toggle: (id: string) => void;
} {
  const [activeIds, setActiveIds] = useState<Set<string>>(loadActiveIds);
  const [stats, setStats] = useState<Map<string, StrategyStats>>(new Map());

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      loadStrategyStats().then((r) => {
        if (alive && r.live) setStats(r.byId);
      });
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const toggle = (id: string) =>
    setActiveIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveActiveIds(next);
      return next;
    });

  const strategies = useMemo(
    () =>
      STRATEGY_DEFS.map((d) => ({
        ...d,
        active: activeIds.has(d.id),
        stats: stats.get(d.id) ?? null,
      })),
    [activeIds, stats],
  );

  return { strategies, activeIds, toggle };
}

/** Oportunidades puntuadas por el motor (tabla inferior). */
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
