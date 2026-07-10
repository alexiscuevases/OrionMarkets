import { useState } from 'react';
import BacktestSection from './BacktestSection';
import EventsSection from './EventsSection';
import OverviewSection from './OverviewSection';
import PaperSection from './PaperSection';
import PipelineSection from './PipelineSection';

const TABS = [
  { id: 'overview', label: 'Resumen' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'backtests', label: 'Backtesting' },
  { id: 'paper', label: 'Paper trading' },
  { id: 'events', label: 'Eventos' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Panel de administración: salud del sistema, pipeline, backtesting,
    cuenta paper y calendario. Solo se monta para sesiones con rol admin
    (el worker re-valida cada petición igualmente). */
export default function AdminDashboard() {
  const [tab, setTab] = useState<TabId>('overview');

  return (
    <main className="admin">
      <div className="admin__tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'tab--on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="admin__body">
        {tab === 'overview' && <OverviewSection />}
        {tab === 'pipeline' && <PipelineSection />}
        {tab === 'backtests' && <BacktestSection />}
        {tab === 'paper' && <PaperSection />}
        {tab === 'events' && <EventsSection />}
      </div>
    </main>
  );
}
