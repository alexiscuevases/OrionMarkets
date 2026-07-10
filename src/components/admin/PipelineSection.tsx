import { useState } from 'react';
import { api } from '../../api/client';
import { fmtDur, fmtTs, useAdminFetch } from './util';

const STATUS_CHIP: Record<string, string> = {
  success: 'chip--buy',
  error: 'chip--sell',
  running: 'chip--star',
  skipped: 'chip--ghost',
};

/** Contadores relevantes de un run, en orden estable y con etiqueta corta. */
const COUNTER_LABELS: [key: string, label: string][] = [
  ['ingested', 'velas'],
  ['newSignals', 'señales'],
  ['evaluated', 'IA'],
  ['reevaluated', 're-IA'],
  ['paperOpened', 'paper+'],
  ['paperClosed', 'paper−'],
  ['indexedCases', 'memoria'],
  ['newLessons', 'lecciones'],
];

/** Pipeline: disparo manual (POST /api/run) + historial de pipeline_runs. */
export default function PipelineSection() {
  const { data, loading, error, reload } = useAdminFetch(() => api.pipelineRuns(30));
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);

  const trigger = async () => {
    setLaunching(true);
    setLaunchMsg(null);
    try {
      const res = await api.triggerRun();
      setLaunchMsg(`Pipeline lanzado (${res.id.slice(0, 8)}…); refresca en unos segundos.`);
      reload();
    } catch (e) {
      setLaunchMsg(e instanceof Error ? e.message : 'no se pudo lanzar el pipeline');
    } finally {
      setLaunching(false);
    }
  };

  const runs = data?.runs ?? [];
  const running = runs.some((r) => r.status === 'running');

  return (
    <div className="admin__stack">
      <div className="admin__row-head">
        <h3 className="admin__h">Pipeline</h3>
        <div className="admin__actions">
          <button className="ghost-btn ghost-btn--sm" onClick={reload} disabled={loading}>
            {loading ? 'Actualizando…' : 'Actualizar'}
          </button>
          <button className="admin-btn" onClick={trigger} disabled={launching || running}>
            {launching ? 'Lanzando…' : running ? 'Hay un run en curso' : 'Ejecutar pipeline'}
          </button>
        </div>
      </div>

      {launchMsg && <p className="admin__note">{launchMsg}</p>}
      {error && <p className="admin__note admin__note--error">{error}</p>}

      <section className="admin-card">
        <h4 className="admin__h4">Últimos runs</h4>
        <div className="admin-table-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Estado</th>
                <th>Disparo</th>
                <th>Inicio</th>
                <th className="ta-r">Duración</th>
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={`chip ${STATUS_CHIP[r.status] ?? 'chip--ghost'}`}>
                      {r.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="dim">{r.trigger}</td>
                  <td className="num">{fmtTs(r.startedAt)}</td>
                  <td className="ta-r num">{fmtDur(r.durationMs)}</td>
                  <td className="admin-cell--wide">
                    {r.error ? (
                      <span className="sell-ink">{r.error}</span>
                    ) : r.counters ? (
                      <span className="dim num">
                        {COUNTER_LABELS
                          .filter(([k]) => r.counters![k] !== undefined)
                          .map(([k, label]) => `${label} ${r.counters![k]}`)
                          .join(' · ')}
                      </span>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && !loading && (
                <tr><td colSpan={5} className="dim">Sin ejecuciones registradas</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
