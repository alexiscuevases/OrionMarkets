import { useEffect, useState } from 'react';
import type { ApiCalibrationBucket } from '../api/client';
import { buildAnalysis, calibratedProb } from '../data/analysis';
import { loadCalibration } from '../data/live';
import { fmtDateTime, pairBySymbol, type AISignal } from '../data/market';
import { SparkleIcon, TargetIcon } from './icons';

interface Props {
  signal: AISignal;
  onClose: () => void;
  onViewChart: (s: AISignal) => void;
}

/* Modal «Análisis IA»: explica por qué el motor puntuó la señal como lo
   hizo — factores a favor / en contra derivados del mismo dossier que vio
   la IA, el score desglosado (técnico / IA / riesgo / calidad) y la
   probabilidad histórica real. */
export default function SignalAnalysis({ signal, onClose, onViewChart }: Props) {
  const [calibration, setCalibration] = useState<ApiCalibrationBucket[]>([]);

  useEffect(() => {
    let alive = true;
    loadCalibration().then((b) => {
      if (alive) setCalibration(b);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const a = buildAnalysis(signal);
  const aiProb = calibratedProb(signal.aiConfidence, calibration);
  const pair = pairBySymbol(signal.symbol);
  const buy = signal.direction === 'buy';
  const evaluated = signal.aiAction != null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="analysis panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Análisis IA de ${signal.symbol}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="analysis__head">
          <span className="analysis__title">
            <SparkleIcon size={14} /> Análisis IA
          </span>
          <span className="analysis__sub num">
            {signal.symbol} · {signal.tf} · {fmtDateTime(signal.time)}
          </span>
          <button className="analysis__close" aria-label="Cerrar" onClick={onClose}>✕</button>
        </header>

        <div className="analysis__scroll">
          <div className="analysis__signal">
            <span className={`dir ${buy ? 'dir--buy' : 'dir--sell'}`}>
              {buy ? '▲ COMPRA' : '▼ VENTA'}
            </span>
            <b>{signal.pattern}</b>
            {signal.overallScore != null && (
              <span className="chip chip--score num">
                Score {signal.overallScore}
                {a.grade && <em>· {a.grade}</em>}
              </span>
            )}
          </div>

          {evaluated ? (
            <>
              {/* Score desglosado: qué parte es técnica, qué parte es IA */}
              <div className="analysis__stats">
                <div className="astat">
                  <label>Técnico</label>
                  <b className="num">{a.technicalScore ?? '—'}</b>
                  <span>indicadores y patrón</span>
                </div>
                <div className="astat">
                  <label>IA</label>
                  <b className="num">{a.aiScore ?? '—'}</b>
                  <span>confianza del modelo</span>
                </div>
                <div className={`astat astat--risk-${(a.risk ?? 'na').toLowerCase()}`}>
                  <label>Riesgo</label>
                  <b>{a.risk ?? '—'}</b>
                  <span>condiciones actuales</span>
                </div>
                <div className="astat">
                  <label>Calidad</label>
                  <b>{a.grade ?? '—'}</b>
                  <span>score global 0-100</span>
                </div>
              </div>

              {(a.patternProb || aiProb) && (
                <div className="analysis__prob">
                  {a.patternProb && (
                    <span>
                      Probabilidad histórica del patrón aquí:{' '}
                      <b className="num">{a.patternProb.pct}%</b>
                      <em className="num"> ({a.patternProb.n} casos)</em>
                    </span>
                  )}
                  {aiProb && (
                    <span>
                      Acierto real de la IA con esta confianza:{' '}
                      <b className="num">{aiProb.pct}%</b>
                      <em className="num"> ({aiProb.n} cierres)</em>
                    </span>
                  )}
                </div>
              )}

              {a.positives.length > 0 && (
                <section className="analysis__block">
                  <h4>Factores a favor</h4>
                  <ul className="factors factors--pos">
                    {a.positives.map((f) => <li key={f.text}>{f.text}</li>)}
                  </ul>
                </section>
              )}

              {a.negatives.length > 0 && (
                <section className="analysis__block">
                  <h4>Factores en contra</h4>
                  <ul className="factors factors--neg">
                    {a.negatives.map((f) => <li key={f.text}>{f.text}</li>)}
                  </ul>
                </section>
              )}

              {signal.aiThesis && (
                <section className="analysis__block">
                  <h4>Tesis de la IA</h4>
                  <p>{signal.aiThesis}</p>
                </section>
              )}

              {signal.aiRisks && (
                <section className="analysis__block">
                  <h4>Riesgos señalados por la IA</h4>
                  <p>{signal.aiRisks}</p>
                </section>
              )}

              {a.conclusion && (
                <div className={`analysis__verdict ${signal.aiAction === 'skip' ? 'analysis__verdict--skip' : ''}`}>
                  <label>Conclusión</label>
                  {a.conclusion}
                </div>
              )}
            </>
          ) : (
            <div className="analysis__pending">
              La IA aún no ha evaluado esta señal: se detectó con reglas
              deterministas (confianza {signal.confidence}%) y entrará en la
              próxima pasada del motor.
            </div>
          )}

          <div className="analysis__levels num">
            <span><label>ENTRADA</label>{signal.entry.toFixed(pair.decimals)}</span>
            <span><label>STOP</label><i className="sell-ink">{signal.stop.toFixed(pair.decimals)}</i></span>
            <span><label>OBJETIVO</label><i className="buy-ink">{signal.target.toFixed(pair.decimals)}</i></span>
            {(signal.rr ?? signal.context?.riskReward) != null && (
              <span><label>R:B</label>1:{(signal.rr ?? signal.context!.riskReward).toFixed(1)}</span>
            )}
          </div>
        </div>

        <footer className="analysis__foot">
          <button className="ghost-btn" onClick={() => onViewChart(signal)}>
            <TargetIcon size={13} /> Ver en gráfico
          </button>
          <button className="ghost-btn" onClick={onClose}>Cerrar</button>
        </footer>
      </div>
    </div>
  );
}
