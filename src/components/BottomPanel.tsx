import { useState } from 'react';
import { gradeForScore } from '../data/analysis';
import {
  fmtDateTime, pairBySymbol, type AISignal,
} from '../data/market';

interface Props {
  signals: AISignal[];
  onView: (signal: AISignal) => void;
  onAnalyze: (signal: AISignal) => void;
  /** Texto del estado vacío cuando hay un motivo concreto (p. ej. sin estrategias activas). */
  emptyMessage?: string;
}

const TABS = ['Oportunidades detectadas', 'Posiciones', 'Historial', 'Alertas'] as const;

export default function BottomPanel({ signals, onView, onAnalyze, emptyMessage }: Props) {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);

  return (
    <section className="bottom panel">
      <nav className="bottom__tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'tab--on' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
            {t === 'Oportunidades detectadas' && (
              <span className="tab__count num">{signals.length}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'Oportunidades detectadas' ? (
        signals.length === 0 ? (
          <div className="bottom__empty">
            <span className="belt-dots" aria-hidden="true">
              <i /><i /><i />
            </span>
            {emptyMessage ?? 'El motor aún no ha puntuado oportunidades'}
          </div>
        ) : (
        <div className="bottom__scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Par</th>
                <th>TF</th>
                <th>Dirección</th>
                <th>Patrón</th>
                <th>Estrategia</th>
                <th className="ta-r">Confianza</th>
                <th className="ta-r">Score</th>
                <th className="ta-r">Entrada</th>
                <th className="ta-r">SL</th>
                <th className="ta-r">TP</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => {
                const pair = pairBySymbol(s.symbol);
                const buy = s.direction === 'buy';
                return (
                  <tr key={s.id} className={s.status === 'Descartada' ? 'row--muted' : undefined}>
                    <td className="num dim">{fmtDateTime(s.time)}</td>
                    <td className="strong">{s.symbol}</td>
                    <td className="num dim">{s.tf}</td>
                    <td>
                      <span className={`dir dir--sm ${buy ? 'dir--buy' : 'dir--sell'}`}>
                        {buy ? '▲ COMPRA' : '▼ VENTA'}
                      </span>
                    </td>
                    <td>{s.pattern}</td>
                    <td className="dim">{s.strategy}</td>
                    <td className="ta-r">
                      <span className="cell-conf">
                        <span className="cell-conf__track">
                          <i style={{ width: `${s.confidence}%` }} />
                        </span>
                        <b className="num">{s.confidence}%</b>
                      </span>
                    </td>
                    <td className="ta-r">
                      {s.overallScore != null ? (
                        <button
                          className="chip chip--score chip--btn num"
                          title="Ver análisis de la IA"
                          onClick={() => onAnalyze(s)}
                        >
                          {s.overallScore}
                          <em>{gradeForScore(s.overallScore)}</em>
                        </button>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="num ta-r">{s.entry.toFixed(pair.decimals)}</td>
                    <td className="num ta-r sell-ink">{s.stop.toFixed(pair.decimals)}</td>
                    <td className="num ta-r buy-ink">{s.target.toFixed(pair.decimals)}</td>
                    <td>
                      <span
                        className={`chip ${
                          s.status === 'Activa'
                            ? 'chip--buy'
                            : s.status === 'Pendiente'
                              ? 'chip--star'
                              : 'chip--ghost'
                        }`}
                      >
                        {s.status}
                        {s.resultPips !== undefined && (
                          <em className="num">
                            {' '}{s.resultPips >= 0 ? '+' : ''}{s.resultPips} pips
                          </em>
                        )}
                      </span>
                    </td>
                    <td>
                      <span className="row-actions">
                        <button
                          className="link-btn link-btn--ai"
                          disabled={s.overallScore == null && s.context == null}
                          title={
                            s.overallScore == null && s.context == null
                              ? 'Pendiente de evaluación IA'
                              : '¿Por qué esta señal?'
                          }
                          onClick={() => onAnalyze(s)}
                        >
                          Análisis
                        </button>
                        <button className="link-btn" onClick={() => onView(s)}>
                          Ver
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )
      ) : (
        <div className="bottom__empty">
          <span className="belt-dots" aria-hidden="true">
            <i /><i /><i />
          </span>
          Sin datos en «{tab}»
        </div>
      )}
    </section>
  );
}
