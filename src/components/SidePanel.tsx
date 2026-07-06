import { useState } from 'react';
import StrategyPanel from './StrategyPanel';
import AIPanel from './AIPanel';
import { SparkleIcon, TargetIcon } from './icons';
import type { AISignal, Strategy } from '../data/market';

interface Props {
  strategies: Strategy[];
  onToggleStrategy: (id: string) => void;
  signals: AISignal[];
  onViewSignal: (signal: AISignal) => void;
  activeSignalId: string | null;
}

type Tab = 'estrategias' | 'ia';

export default function SidePanel({
  strategies, onToggleStrategy, signals, onViewSignal, activeSignalId,
}: Props) {
  const [tab, setTab] = useState<Tab>('ia');

  return (
    <aside className="side panel">
      <nav className="side__tabs">
        <button
          className={`tab ${tab === 'ia' ? 'tab--on tab--nebula' : ''}`}
          onClick={() => setTab('ia')}
        >
          <SparkleIcon size={13} /> Orion AI
          <span className="tab__count num">{signals.length}</span>
        </button>
        <button
          className={`tab ${tab === 'estrategias' ? 'tab--on' : ''}`}
          onClick={() => setTab('estrategias')}
        >
          <TargetIcon size={13} /> Estrategias
        </button>
      </nav>

      {tab === 'estrategias' ? (
        <StrategyPanel strategies={strategies} onToggle={onToggleStrategy} />
      ) : (
        <AIPanel signals={signals} onView={onViewSignal} activeSignalId={activeSignalId} />
      )}
    </aside>
  );
}
