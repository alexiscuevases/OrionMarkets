import { useState } from 'react';
import {
  fmtDateTime, pairBySymbol, type AISignal,
} from '../data/market';

interface Props {
  signals: AISignal[];
  onView: (signal: AISignal) => void;
}

const TABS = ['Oportunidades detectadas', 'Posiciones', 'Historial', 'Alertas'] as const;

export default function BottomPanel({ signals, onView }: Props) {
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
                  <tr key={s.id}>
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
                        <span className="chip chip--score num">{s.overallScore}</span>
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
                      <button className="link-btn" onClick={() => onView(s)}>
                        Ver
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bottom__empty">
          <span className="belt-dots" aria-hidden="true">
            <i /><i /><i />
          </span>
          Sin datos en «{tab}» — vista de demostración
        </div>
      )}
    </section>
  );
}
