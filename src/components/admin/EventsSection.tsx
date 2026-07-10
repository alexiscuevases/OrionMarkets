import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { fmtTs, useAdminFetch } from './util';

const IMPACT_CHIP: Record<string, string> = {
  high: 'chip--sell',
  medium: 'chip--star',
  low: 'chip--ghost',
};

const PLACEHOLDER = `[
  { "ts": 1752148800000, "currency": "USD", "impact": "high", "title": "CPI m/m", "forecast": "0.2%" }
]`;

/** Calendario económico: próximos eventos cargados y alta manual por JSON
    (POST /api/admin/events). */
export default function EventsSection() {
  const { data, loading, error, reload } = useAdminFetch(() => api.events());
  const [raw, setRaw] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    setUploadMsg(null);
    let events: unknown;
    try {
      events = JSON.parse(raw);
    } catch {
      setUploadMsg('JSON inválido');
      return;
    }
    // se acepta tanto el array directo como el envoltorio {events: [...]}
    const list = Array.isArray(events)
      ? events
      : (events as { events?: unknown[] })?.events;
    if (!Array.isArray(list) || list.length === 0) {
      setUploadMsg('se espera un array de eventos {ts, currency, impact, title, …}');
      return;
    }
    setUploading(true);
    try {
      const res = await api.uploadEvents(list);
      setUploadMsg(`Cargados ${res.upserted} de ${res.received} eventos.`);
      setRaw('');
      reload();
    } catch (err) {
      setUploadMsg(err instanceof Error ? err.message : 'no se pudieron cargar los eventos');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="admin__stack">
      <div className="admin__row-head">
        <h3 className="admin__h">Calendario económico</h3>
        <button className="ghost-btn ghost-btn--sm" onClick={reload} disabled={loading}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {error && <p className="admin__note admin__note--error">{error}</p>}

      <section className="admin-card">
        <h4 className="admin__h4">Próximos eventos (7 días)</h4>
        <div className="admin-table-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Fecha (local)</th>
                <th>Divisa</th>
                <th>Impacto</th>
                <th>Evento</th>
                <th className="ta-r">Previsión</th>
                <th className="ta-r">Anterior</th>
                <th className="ta-r">Real</th>
              </tr>
            </thead>
            <tbody>
              {(data?.events ?? []).map((ev) => (
                <tr key={`${ev.ts}|${ev.currency}|${ev.title}`}>
                  <td className="num">{fmtTs(ev.ts)}</td>
                  <td className="strong">{ev.currency}</td>
                  <td>
                    <span className={`chip ${IMPACT_CHIP[ev.impact] ?? 'chip--ghost'}`}>
                      {ev.impact.toUpperCase()}
                    </span>
                  </td>
                  <td>{ev.title}</td>
                  <td className="ta-r num dim">{ev.forecast ?? '—'}</td>
                  <td className="ta-r num dim">{ev.previous ?? '—'}</td>
                  <td className="ta-r num">{ev.actual ?? '—'}</td>
                </tr>
              ))}
              {(data?.events ?? []).length === 0 && !loading && (
                <tr><td colSpan={7} className="dim">Sin eventos en la ventana actual</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-card">
        <h4 className="admin__h4">Cargar eventos</h4>
        <p className="admin__note">
          Pega un array JSON de eventos (máx. 500): <code>ts</code> en ms UTC,{' '}
          <code>currency</code> (EUR/USD/GBP/JPY…), <code>impact</code> (high/medium/low),{' '}
          <code>title</code> y opcionalmente <code>forecast</code>/<code>previous</code>/<code>actual</code>.
        </p>
        <form className="admin-form admin-form--col" onSubmit={upload}>
          <textarea
            className="admin-json"
            rows={8}
            placeholder={PLACEHOLDER}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            spellCheck={false}
          />
          <button className="admin-btn" type="submit" disabled={uploading || raw.trim() === ''}>
            {uploading ? 'Cargando…' : 'Cargar eventos'}
          </button>
        </form>
        {uploadMsg && <p className="admin__note">{uploadMsg}</p>}
      </section>
    </div>
  );
}
