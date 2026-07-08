import StrategyPanel from './StrategyPanel';
import { TargetIcon } from './icons';
import type { Strategy } from '../data/market';

interface Props {
  strategies: Strategy[];
  onToggleStrategy: (id: string) => void;
}

/* Panel lateral. Las señales viven en «Oportunidades detectadas» (tabla
   inferior); aquí queda Estrategias y espacio para la próxima vista. */
export default function SidePanel({ strategies, onToggleStrategy }: Props) {
  return (
    <aside className="side panel">
      <nav className="side__tabs">
        <button className="tab tab--on">
          <TargetIcon size={13} /> Estrategias
        </button>
      </nav>
      <StrategyPanel strategies={strategies} onToggle={onToggleStrategy} />
    </aside>
  );
}
