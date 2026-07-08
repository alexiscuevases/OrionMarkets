import { useMemo, useState } from 'react';
import TopBar from './components/TopBar';
import Watchlist from './components/Watchlist';
import ChartPanel from './components/ChartPanel';
import SidePanel from './components/SidePanel';
import BottomPanel from './components/BottomPanel';
import SignalAnalysis from './components/SignalAnalysis';
import { useMarketData, useOpportunities, useStrategies } from './hooks/useMarketData';
import { isSignalEnabled, strategyIdForPattern } from './data/strategies';
import type { AISignal } from './data/market';
import './App.css';

export default function App() {
  const [symbol, setSymbol] = useState('EURUSD');
  const [tf, setTf] = useState('H1');
  const [activeSignal, setActiveSignal] = useState<AISignal | null>(null);
  // señal cuyo análisis IA se está viendo en el modal
  const [analysisSignal, setAnalysisSignal] = useState<AISignal | null>(null);

  // catálogo de estrategias (una por detector del motor) con stats reales;
  // el interruptor de cada una decide qué señales se muestran en la UI
  const { strategies, activeIds, toggle } = useStrategies();
  // serie + señales del par en pantalla, siempre desde el motor Cloudflare
  const market = useMarketData(symbol, tf);
  // oportunidades puntuadas por el escáner global
  const opportunities = useOpportunities();

  // sobre el gráfico solo se pintan señales de estrategias activas
  const chartSignals = useMemo(
    () => market.signals.filter((s) => isSignalEnabled(s.pattern, activeIds)),
    [market.signals, activeIds],
  );

  // todas las señales accionables en un solo sitio (tabla inferior):
  // oportunidades puntuadas del escáner primero, luego las señales abiertas
  // del par en pantalla; siempre limitadas a las estrategias activas
  const openSignals = useMemo(() => {
    const seen = new Set<string>();
    return [...opportunities.signals, ...market.signals]
      .filter((s) => s.outcome === 'open')
      .filter((s) => isSignalEnabled(s.pattern, activeIds))
      .filter((s) => !seen.has(s.id) && seen.add(s.id));
  }, [market.signals, opportunities.signals, activeIds]);

  const noneActive = activeIds.size === 0;

  const toggleStrategy = (id: string) => {
    // al apagar la estrategia de la señal enfocada, se suelta el foco
    if (
      activeIds.has(id) &&
      activeSignal &&
      strategyIdForPattern(activeSignal.pattern) === id
    ) {
      setActiveSignal(null);
    }
    toggle(id);
  };

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
          signals={chartSignals}
          live={market.live}
          loading={market.loading}
        />
        <SidePanel strategies={strategies} onToggleStrategy={toggleStrategy} />
        <BottomPanel
          signals={openSignals}
          onView={viewSignal}
          onAnalyze={setAnalysisSignal}
          emptyMessage={
            noneActive
              ? 'No hay estrategias activas: actívalas en el panel lateral'
              : undefined
          }
        />
      </main>
      {analysisSignal && (
        <SignalAnalysis
          signal={analysisSignal}
          onClose={() => setAnalysisSignal(null)}
          onViewChart={(s) => {
            viewSignal(s);
            setAnalysisSignal(null);
          }}
        />
      )}
    </div>
  );
}
