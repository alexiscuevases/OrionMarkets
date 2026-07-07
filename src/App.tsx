import { useMemo, useState } from 'react';
import TopBar from './components/TopBar';
import Watchlist from './components/Watchlist';
import ChartPanel from './components/ChartPanel';
import SidePanel from './components/SidePanel';
import BottomPanel from './components/BottomPanel';
import { useMarketData, useOpportunities } from './hooks/useMarketData';
import { STRATEGIES, type AISignal, type Strategy } from './data/market';
import './App.css';

export default function App() {
  const [symbol, setSymbol] = useState('EURUSD');
  const [tf, setTf] = useState('H1');
  const [strategies, setStrategies] = useState<Strategy[]>(STRATEGIES);
  const [activeSignal, setActiveSignal] = useState<AISignal | null>(null);

  // serie + señales del par en pantalla, siempre desde el motor Cloudflare
  const market = useMarketData(symbol, tf);
  // oportunidades puntuadas por el escáner global
  const opportunities = useOpportunities();

  // el panel IA mezcla las señales del par en pantalla con las del escáner
  const panelSignals = useMemo(() => {
    const seen = new Set<string>();
    return [...market.signals, ...opportunities.signals]
      .filter((s) => !seen.has(s.id) && seen.add(s.id))
      .slice(0, 9);
  }, [market.signals, opportunities.signals]);

  const toggleStrategy = (id: string) =>
    setStrategies((prev) =>
      prev.map((s) => (s.id === id ? { ...s, active: !s.active } : s)),
    );

  const viewSignal = (s: AISignal) => {
    setSymbol(s.symbol);
    setTf(s.tf);
    setActiveSignal(s);
  };

  const changeSymbol = (sym: string) => {
    setSymbol(sym);
    setActiveSignal(null);
  };

  const changeTf = (next: string) => {
    setTf(next);
    setActiveSignal(null);
  };

  return (
    <div className="app">
      <TopBar />
      <main className="workspace">
        <Watchlist selected={symbol} onSelect={changeSymbol} />
        <ChartPanel
          symbol={symbol}
          tf={tf}
          onTfChange={changeTf}
          activeSignal={activeSignal}
          series={market.series}
          signals={market.signals}
          live={market.live}
          loading={market.loading}
        />
        <SidePanel
          strategies={strategies}
          onToggleStrategy={toggleStrategy}
          signals={panelSignals}
          onViewSignal={viewSignal}
          activeSignalId={activeSignal?.id ?? null}
        />
        <BottomPanel signals={opportunities.signals} onView={viewSignal} />
      </main>
    </div>
  );
}
