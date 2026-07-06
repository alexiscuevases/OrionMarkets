import { useMemo, useState } from 'react';
import TopBar from './components/TopBar';
import Watchlist from './components/Watchlist';
import ChartPanel from './components/ChartPanel';
import SidePanel from './components/SidePanel';
import BottomPanel from './components/BottomPanel';
import {
  STRATEGIES, getScannerSignals, getSignals, type AISignal, type Strategy,
} from './data/market';
import './App.css';

export default function App() {
  const [symbol, setSymbol] = useState('EURUSD');
  const [tf, setTf] = useState('H1');
  const [strategies, setStrategies] = useState<Strategy[]>(STRATEGIES);
  const [activeSignal, setActiveSignal] = useState<AISignal | null>(null);

  const scannerSignals = useMemo(() => getScannerSignals(), []);
  const chartSignals = useMemo(
    () => getSignals(symbol, tf).slice().reverse(),
    [symbol, tf],
  );

  // el panel IA mezcla las señales del par en pantalla con las del escáner global
  const panelSignals = useMemo(() => {
    const seen = new Set<string>();
    return [...chartSignals, ...scannerSignals]
      .filter((s) => !seen.has(s.id) && seen.add(s.id))
      .slice(0, 9);
  }, [chartSignals, scannerSignals]);

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
        <ChartPanel symbol={symbol} tf={tf} onTfChange={changeTf} activeSignal={activeSignal} />
        <SidePanel
          strategies={strategies}
          onToggleStrategy={toggleStrategy}
          signals={panelSignals}
          onViewSignal={viewSignal}
          activeSignalId={activeSignal?.id ?? null}
        />
        <BottomPanel signals={scannerSignals} onView={viewSignal} />
      </main>
    </div>
  );
}
