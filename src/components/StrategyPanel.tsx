import Sparkline from './Sparkline';
import type { Strategy } from '../data/strategies';

interface Props {
  strategies: Strategy[];
  onToggle: (id: string) => void;
}

const RISK_TONE: Record<Strategy['risk'], string> = {
  Bajo: 'chip--buy',
  Medio: 'chip--star',
  Alto: 'chip--sell',
};

/* Rendimiento real del motor (últimos 30 días). Sin cierres suficientes
   se muestra «—» en lugar de inventar números. */
function fmtFactor(pf: number | null): string {
  if (pf === null) return '—';
  return Number.isFinite(pf) ? pf.toFixed(2) : '∞';
}

export default function StrategyPanel({ strategies, onToggle }: Props) {
  const activeCount = strategies.filter((s) => s.active).length;

  return (
    <div className="side-scroll">
      <div className="side-summary">
        <span>
          <b className="num">{activeCount}</b> de <b className="num">{strategies.length}</b> estrategias activas
        </span>
        <span className="side-summary__hint">
          Solo las activas aparecen en el gráfico y en oportunidades · stats reales 30d
        </span>
      </div>

      {strategies.map((s) => {
        const st = s.stats;
        const equity = st?.equity ?? [];
        const positive = (equity[equity.length - 1] ?? 0) >= 0;
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
                <b
                  className="num"
                  title={st ? `${st.wins} TP · ${st.losses} SL en 30 días` : 'Sin datos del motor'}
                >
                  {st?.winRate != null ? `${st.winRate}%` : '—'}
                </b>
              </div>
              <div className="stat">
                <label>Factor</label>
                <b className="num" title="Beneficio bruto en R / nº de stops">
                  {fmtFactor(st?.profitFactor ?? null)}
                </b>
              </div>
              <div className="stat">
                <label>Señales 30d</label>
                <b className="num" title={st ? `${st.open} aún abiertas` : undefined}>
                  {st ? st.signals30d : '—'}
                </b>
              </div>
              <Sparkline
                data={equity}
                width={76}
                height={26}
                stroke={positive ? 'var(--buy)' : 'var(--sell)'}
                fill={positive ? 'var(--buy-glow)' : 'var(--sell-glow)'}
              />
            </footer>
          </article>
        );
      })}
    </div>
  );
}
