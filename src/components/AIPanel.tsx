import {
  fmtDateTime, pairBySymbol, type AISignal,
} from '../data/market';
import { ArrowDown, ArrowUp, SparkleIcon, TargetIcon } from './icons';

interface Props {
  signals: AISignal[];
  onView: (signal: AISignal) => void;
  activeSignalId: string | null;
}

const DIM_LABELS: Record<string, string> = {
  trend: 'Tendencia',
  momentum: 'Momentum',
  volume: 'Volumen',
  volatility: 'Volatilidad',
  macro: 'Macro',
  news: 'Noticias',
  sentiment: 'Sentimiento',
  institutional: 'Institucional',
  riskReward: 'Risk/Reward',
};

/** Desglose del score como tooltip: una línea de estrellas por dimensión. */
function scoreTitle(scores?: Record<string, number> | null): string | undefined {
  if (!scores) return undefined;
  return Object.entries(scores)
    .map(([k, v]) => `${DIM_LABELS[k] ?? k}: ${'★'.repeat(v)}${'☆'.repeat(Math.max(0, 5 - v))}`)
    .join('\n');
}

export default function AIPanel({ signals, onView, activeSignalId }: Props) {
  return (
    <div className="side-scroll">
      <div className="ai-scanner">
        <div className="ai-scanner__head">
          <SparkleIcon size={14} />
          <b>Escáner de patrones</b>
          <span className="ai-scanner__live">
            EN VIVO<span className="ai-pill__dot" />
          </span>
        </div>
        <p>
          Modelo <b>orion-fx-v2</b> analizando <b className="num">14</b> pares en M15 · H1 · H4.
          Cruza patrones detectados con tus estrategias activas.
        </p>
        <div className="ai-scanner__bar">
          <span style={{ width: '68%' }} />
        </div>
        <div className="ai-scanner__foot num">Última pasada hace 12 s · siguiente en 48 s</div>
      </div>

      {signals.map((s) => {
        const pair = pairBySymbol(s.symbol);
        const buy = s.direction === 'buy';
        const rr = Math.abs((s.target - s.entry) / (s.entry - s.stop));
        return (
          <article
            key={s.id}
            className={`signal ${activeSignalId === s.id ? 'signal--focus' : ''}`}
          >
            <header className="signal__head">
              <span className={`dir ${buy ? 'dir--buy' : 'dir--sell'}`}>
                {buy ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                {buy ? 'COMPRA' : 'VENTA'}
              </span>
              <b className="signal__pair">
                {s.symbol} <em className="num">{s.tf}</em>
              </b>
              {s.overallScore != null && (
                <span
                  className="chip chip--score num"
                  title={scoreTitle(s.scores)}
                >
                  {s.overallScore}/100
                </span>
              )}
              <time className="num">{fmtDateTime(s.time)}</time>
            </header>

            <div className="signal__pattern" title={s.aiThesis ?? undefined}>
              <span>Patrón: <b>{s.pattern}</b></span>
              <span className="signal__strategy">{s.live ? s.strategy : `vía ${s.strategy}`}</span>
            </div>

            <div className="conf">
              <label>Confianza</label>
              <div className="conf__track">
                <span
                  className={s.confidence >= 80 ? 'conf__fill conf__fill--hi' : 'conf__fill'}
                  style={{ width: `${s.confidence}%` }}
                />
              </div>
              <b className="num">{s.confidence}%</b>
            </div>

            <div className="signal__levels num">
              <span><label>Entrada</label>{s.entry.toFixed(pair.decimals)}</span>
              <span><label>SL</label>{s.stop.toFixed(pair.decimals)}</span>
              <span><label>TP</label>{s.target.toFixed(pair.decimals)}</span>
              <span><label>R:R</label>1:{rr.toFixed(1)}</span>
            </div>

            <footer className="signal__foot">
              <button className="ghost-btn ghost-btn--sm" onClick={() => onView(s)}>
                <TargetIcon size={12} /> Ver en gráfico
              </button>
              <button className={`ghost-btn ghost-btn--sm ${buy ? 'ghost-btn--buy' : 'ghost-btn--sell'}`}>
                Operar señal
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
