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

  // todas las señales accionables en un solo sitio (tabla inferior):
  // oportunidades puntuadas del escáner primero, luego las señales abiertas
  // del par en pantalla; las cerradas se consultan en el gráfico con su filtro
  const openSignals = useMemo(() => {
    const seen = new Set<string>();
    return [...opportunities.signals, ...market.signals]
      .filter((s) => s.outcome === 'open')
      .filter((s) => !seen.has(s.id) && seen.add(s.id));
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
          onExitSignal={() => setActiveSignal(null)}
          series={market.series}
          signals={market.signals}
          live={market.live}
          loading={market.loading}
        />
        <SidePanel strategies={strategies} onToggleStrategy={toggleStrategy} />
        <BottomPanel signals={openSignals} onView={viewSignal} />
      </main>
    </div>
  );
}
