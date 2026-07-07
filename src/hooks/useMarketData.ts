import { useEffect, useState } from 'react';
import {
  isLiveCapable, loadEngineStatus, loadMarketData, loadOpportunities,
  type EngineStatus, type MarketData,
} from '../data/live';
import { getSeries, getSignals, getScannerSignals, type AISignal } from '../data/market';

const REFRESH_MS = 60_000;

/** Serie + señales del par/TF en pantalla. Pinta el simulador al instante
    y lo sustituye por datos del motor cuando llegan. */
export function useMarketData(symbol: string, tf: string): MarketData {
  const [data, setData] = useState<MarketData>(() => mock(symbol, tf));

  useEffect(() => {
    let alive = true;
    setData(mock(symbol, tf));
    if (!isLiveCapable(symbol, tf)) return;

    const refresh = () =>
      loadMarketData(symbol, tf).then((d) => {
        if (alive && d.live) setData(d);
      });

    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol, tf]);

  return data;
}

function mock(symbol: string, tf: string): MarketData {
  return {
    series: getSeries(symbol, tf),
    signals: getSignals(symbol, tf).slice().reverse(),
    live: false,
  };
}

/** Oportunidades puntuadas por el motor (tabla inferior + panel IA). */
export function useOpportunities(): { signals: AISignal[]; live: boolean } {
  const [state, setState] = useState<{ signals: AISignal[]; live: boolean }>(() => ({
    signals: getScannerSignals(),
    live: false,
  }));

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      loadOpportunities().then((r) => {
        if (alive && r.live) setState(r);
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
