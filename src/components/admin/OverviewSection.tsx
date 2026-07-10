import { api } from '../../api/client';
import { fmtAge, fmtMoney, fmtTs, useAdminFetch } from './util';

/** Resumen: semáforo de salud, versiones, uso de IA 7 días, tamaño de
    tablas D1 y frescura de velas por mercado (/api/admin/metrics). */
export default function OverviewSection() {
  const { data, loading, error, reload } = useAdminFetch(() => api.adminMetrics());

  if (loading && !data) return <p className="admin__note">Cargando métricas…</p>;
  if (error && !data) return <p className="admin__note admin__note--error">{error}</p>;
  if (!data) return null;

  const { health, ai7d, tables, versions } = data;
  const errRate24h = health.ai.last24h.calls > 0
    ? Math.round((health.ai.last24h.errors / health.ai.last24h.calls) * 100)
    : 0;

  return (
    <div className="admin__stack">
      <div className="admin__row-head">
        <h3 className="admin__h">Salud del sistema</h3>
        <button className="ghost-btn ghost-btn--sm" onClick={reload} disabled={loading}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      <div className="acard-grid">
        <StatusCard
          label="Sistema"
          ok={health.ok}
          detail={health.ok ? 'Todo operativo' : 'Revisar módulos en rojo'}
        />
        <StatusCard
          label="Pipeline"
          ok={health.pipeline.ok}
          detail={
            health.pipeline.lastSuccess
              ? `Último éxito ${fmtTs(health.pipeline.lastSuccess.finishedAt)}`
              : 'Sin runs exitosos'
          }
        />
        <StatusCard
          label="Datos"
          ok={health.data.ok}
          detail={
            health.data.ok
              ? `${health.data.openSignals} señales abiertas`
              : `${health.data.staleMarkets.length} mercados sin velas frescas`
          }
        />
        <StatusCard
          label="IA (24 h)"
          ok={health.ai.ok}
          detail={`${health.ai.last24h.calls} llamadas · ${errRate24h}% errores`}
        />
        <StatusCard
          label="Memoria vectorial"
          ok={health.vector.totalClosed === 0 || health.vector.indexed > 0}
          detail={`${health.vector.indexed} / ${health.vector.totalClosed} cierres indexados`}
        />
      </div>

      <div className="admin__cols">
        <section className="admin-card">
          <h4 className="admin__h4">Versiones activas</h4>
          <dl className="kv-list">
            <div><dt>Detector</dt><dd className="num">{versions.detector}</dd></div>
            <div><dt>Prompt</dt><dd className="num">{versions.prompt}</dd></div>
            <div><dt>Estrategia</dt><dd className="num">{versions.strategy}</dd></div>
            <div><dt>Modelo IA</dt><dd className="num">{versions.model}</dd></div>
          </dl>
        </section>

        <section className="admin-card">
          <h4 className="admin__h4">Uso de IA · 7 días</h4>
          <dl className="kv-list">
            <div><dt>Llamadas</dt><dd className="num">{ai7d.calls}</dd></div>
            <div><dt>Errores</dt><dd className="num">{ai7d.errors}</dd></div>
            <div>
              <dt>Tokens</dt>
              <dd className="num">{fmtMoney(ai7d.tokensIn, 0)} in · {fmtMoney(ai7d.tokensOut, 0)} out</dd>
            </div>
            <div><dt>Coste estimado</dt><dd className="num">${fmtMoney(ai7d.estCostUsd, 4)}</dd></div>
            <div>
              <dt>Latencia media</dt>
              <dd className="num">{ai7d.avgLatencyMs != null ? `${Math.round(ai7d.avgLatencyMs)} ms` : '—'}</dd>
            </div>
          </dl>
          {ai7d.byKind.length > 0 && (
            <table className="grid-table">
              <thead>
                <tr><th>Tipo</th><th className="ta-r">Llamadas</th><th className="ta-r">Errores</th><th className="ta-r">Coste</th></tr>
              </thead>
              <tbody>
                {ai7d.byKind.map((k) => (
                  <tr key={k.kind}>
                    <td>{k.kind}</td>
                    <td className="ta-r num">{k.calls}</td>
                    <td className={`ta-r num ${k.errors > 0 ? 'sell-ink' : 'dim'}`}>{k.errors}</td>
                    <td className="ta-r num">${fmtMoney(k.estCostUsd, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="admin-card">
          <h4 className="admin__h4">Tablas D1</h4>
          <dl className="kv-list">
            {Object.entries(tables).map(([table, n]) => (
              <div key={table}>
                <dt>{table}</dt>
                <dd className="num">{fmtMoney(n, 0)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="admin-card">
        <h4 className="admin__h4">Frescura de velas por mercado</h4>
        <div className="admin-table-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Par</th>
                <th>Intervalo</th>
                <th>Última vela</th>
                <th className="ta-r">Antigüedad</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {health.data.freshness.map((f) => (
                <tr key={`${f.symbol}|${f.interval}`} className={f.stale ? '' : 'row--muted'}>
                  <td className="strong">{f.symbol}</td>
                  <td className="num">{f.interval}</td>
                  <td className="num">{fmtTs(f.lastCandleTs)}</td>
                  <td className="ta-r num">{fmtAge(f.ageMs)}</td>
                  <td>
                    <span className={`chip ${f.stale ? 'chip--sell' : 'chip--buy'}`}>
                      {f.stale ? 'STALE' : 'OK'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatusCard({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className={`acard ${ok ? 'acard--ok' : 'acard--bad'}`}>
      <span className="acard__dot" />
      <div>
        <b>{label}</b>
        <p>{detail}</p>
      </div>
    </div>
  );
}
