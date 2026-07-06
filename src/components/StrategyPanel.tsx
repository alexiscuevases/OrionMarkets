import Sparkline from './Sparkline';
import type { Strategy } from '../data/market';

interface Props {
  strategies: Strategy[];
  onToggle: (id: string) => void;
}

const RISK_TONE: Record<Strategy['risk'], string> = {
  Bajo: 'chip--buy',
  Medio: 'chip--star',
  Alto: 'chip--sell',
};

export default function StrategyPanel({ strategies, onToggle }: Props) {
  const activeCount = strategies.filter((s) => s.active).length;

  return (
    <div className="side-scroll">
      <div className="side-summary">
        <span>
          <b className="num">{activeCount}</b> de <b className="num">{strategies.length}</b> estrategias activas
        </span>
        <span className="side-summary__hint">Las activas generan señales en tiempo real</span>
      </div>

      {strategies.map((s) => {
        const positive = s.equity[s.equity.length - 1] >= 0;
        return (
          <article key={s.id} className={`strat ${s.active ? 'strat--on' : ''}`}>
            <header className="strat__head">
              <div>
                <h3>{s.name}</h3>
                <p>{s.desc}</p>
              </div>
              <button
                className={`switch ${s.active ? 'switch--on' : ''}`}
                role="switch"
                aria-checked={s.active}
                aria-label={`Activar ${s.name}`}
                onClick={() => onToggle(s.id)}
              >
                <span className="switch__knob" />
              </button>
            </header>

            <div className="strat__tags">
              <span className="chip chip--ghost num">{s.tf}</span>
              <span className="chip chip--ghost">{s.pairs}</span>
              <span className={`chip ${RISK_TONE[s.risk]}`}>Riesgo {s.risk.toLowerCase()}</span>
            </div>

            <footer className="strat__stats">
              <div className="stat">
                <label>Acierto</label>
                <b className="num">{s.winRate}%</b>
              </div>
              <div className="stat">
                <label>Factor</label>
                <b className="num">{s.profitFactor.toFixed(2)}</b>
              </div>
              <div className="stat">
                <label>Señales 30d</label>
                <b className="num">{s.signals30d}</b>
              </div>
              <Sparkline
                data={s.equity}
                width={76}
                height={26}
                stroke={positive ? 'var(--buy)' : 'var(--sell)'}
                fill={positive ? 'var(--buy-glow)' : 'var(--sell-glow)'}
              />
            </footer>
          </article>
        );
      })}

      <button className="ghost-btn">+ Crear estrategia personalizada</button>
    </div>
  );
}
