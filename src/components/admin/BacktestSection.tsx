import { useState, type FormEvent } from 'react';
import { api, type ApiBacktestResult } from '../../api/client';
import EquityChart from './EquityChart';
import { fmtDate, fmtMoney, fmtPct, fmtR, fmtTs, fmtWinRate, useAdminFetch } from './util';

/* Universo del motor (worker/src/types.ts); el worker valida igualmente. */
const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY'];
const INTERVALS = ['5min', '15min', '30min', '45min', '1h'];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Backtesting: formulario (POST /api/backtest), resultado con métricas,
    curva de equity y desglose, más el historial de backtests guardados. */
export default function BacktestSection() {
  const saved = useAdminFetch(() => api.backtests());

  const [form, setForm] = useState({
    symbol: 'EURUSD',
    interval: '1h',
    from: isoDaysAgo(120),
    to: isoDaysAgo(0),
    riskPct: '1',
    initialBalance: '10000',
    minConfidence: '0',
    patterns: '',
  });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiBacktestResult | null>(null);
  const [loadingSavedId, setLoadingSavedId] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const run = async (e: FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setError(null);
    try {
      const patterns = form.patterns
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const res = await api.runBacktest({
        symbol: form.symbol,
        interval: form.interval,
        from: form.from,
        to: form.to,
        riskPct: Number(form.riskPct) || undefined,
        initialBalance: Number(form.initialBalance) || undefined,
        minConfidence: Number(form.minConfidence) || undefined,
        patterns: patterns.length > 0 ? patterns : undefined,
      });
      setResult(res);
      saved.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'no se pudo ejecutar el backtest');
    } finally {
      setRunning(false);
    }
  };

  const loadSaved = async (id: string) => {
    setLoadingSavedId(id);
    setError(null);
    try {
      // el guardado no conserva los trades (su columna es el recuento)
      const stored = await api.backtest(id);
      setResult({ ...stored, trades: undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'no se pudo cargar el backtest');
    } finally {
      setLoadingSavedId(null);
    }
  };

  return (
    <div className="admin__stack">
      <h3 className="admin__h">Backtesting</h3>

      <section className="admin-card">
        <h4 className="admin__h4">Nuevo backtest</h4>
        <p className="admin__note">
          Ejecuta el detector live sobre el histórico, con corte duro en la fecha final
          (sin look-ahead). No escribe en señales ni evaluaciones.
        </p>
        <form className="admin-form" onSubmit={run}>
          <label className="afield">
            Par
            <select value={form.symbol} onChange={set('symbol')}>
              {SYMBOLS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="afield">
            Intervalo
            <select value={form.interval} onChange={set('interval')}>
              {INTERVALS.map((i) => <option key={i}>{i}</option>)}
            </select>
          </label>
          <label className="afield">
            Desde
            <input type="date" value={form.from} onChange={set('from')} required />
          </label>
          <label className="afield">
            Hasta
            <input type="date" value={form.to} onChange={set('to')} required />
          </label>
          <label className="afield">
            Riesgo por trade (%)
            <input type="number" min="0.05" max="10" step="0.05" value={form.riskPct} onChange={set('riskPct')} />
          </label>
          <label className="afield">
            Balance inicial (USD)
            <input type="number" min="100" max="10000000" step="100" value={form.initialBalance} onChange={set('initialBalance')} />
          </label>
          <label className="afield">
            Confianza mínima
            <input type="number" min="0" max="100" step="5" value={form.minConfidence} onChange={set('minConfidence')} />
          </label>
          <label className="afield afield--wide">
            Patrones (nombres exactos separados por coma; vacío = todos)
            <input
              type="text"
              placeholder="Pin bar alcista, Cruce EMA 20/50…"
              value={form.patterns}
              onChange={set('patterns')}
            />
          </label>
          <button className="admin-btn" type="submit" disabled={running}>
            {running ? 'Ejecutando…' : 'Ejecutar backtest'}
          </button>
        </form>
        {error && <p className="admin__note admin__note--error">{error}</p>}
      </section>

      {result && <BacktestResult result={result} />}

      <section className="admin-card">
        <div className="admin__row-head">
          <h4 className="admin__h4">Backtests guardados</h4>
          <button className="ghost-btn ghost-btn--sm" onClick={saved.reload} disabled={saved.loading}>
            {saved.loading ? 'Actualizando…' : 'Actualizar'}
          </button>
        </div>
        <div className="admin-table-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Par</th>
                <th>Intervalo</th>
                <th>Rango</th>
                <th className="ta-r">Trades</th>
                <th>Detector</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(saved.data?.backtests ?? []).map((b) => (
                <tr key={b.id}>
                  <td className="num">{fmtTs(b.createdAt)}</td>
                  <td className="strong">{b.symbol}</td>
                  <td className="num">{b.interval}</td>
                  <td className="num dim">{fmtDate(b.fromTs)} → {fmtDate(b.toTs)}</td>
                  <td className="ta-r num">{b.trades}</td>
                  <td className="num dim">{b.detectorVersion}</td>
                  <td>
                    <button
                      className="link-btn"
                      onClick={() => loadSaved(b.id)}
                      disabled={loadingSavedId !== null}
                    >
                      {loadingSavedId === b.id ? 'Cargando…' : 'Ver'}
                    </button>
                  </td>
                </tr>
              ))}
              {(saved.data?.backtests ?? []).length === 0 && !saved.loading && (
                <tr><td colSpan={7} className="dim">Aún no hay backtests guardados</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const MAX_TRADE_ROWS = 200;

function BacktestResult({ result }: { result: ApiBacktestResult }) {
  const m = result.metrics;
  const trades = result.trades ?? [];
  const profit = m.netR >= 0;

  return (
    <section className="admin-card">
      <h4 className="admin__h4">
        Resultado · {result.symbol} {result.interval} · {fmtDate(result.fromTs)} → {fmtDate(result.toTs)}
        <span className="chip chip--ghost">detector {result.detectorVersion}</span>
      </h4>

      <div className="bt-stats">
        <Stat label="Trades" value={String(m.totalTrades)} sub={`${m.openAtEnd} abiertos al corte`} />
        <Stat label="Win rate" value={fmtWinRate(m.winRate)} sub={`${m.wins}W · ${m.losses}L · ${m.expired}exp`} />
        <Stat
          label="Profit factor"
          value={m.profitFactor === null ? '—' : m.profitFactor === Infinity ? '∞' : fmtMoney(m.profitFactor)}
        />
        <Stat label="Expectancy" value={fmtR(m.expectancyR)} sub={`RR medio ${fmtMoney(m.avgRr)}`} />
        <Stat label="Neto" value={fmtR(m.netR)} tone={profit ? 'buy' : 'sell'} />
        <Stat label="Drawdown máx." value={`${fmtMoney(m.maxDrawdownR)}R`} sub={fmtPct(m.maxDrawdownPct)} tone="sell" />
        <Stat
          label="Balance final"
          value={`$${fmtMoney(m.finalBalance)}`}
          sub={fmtPct(m.returnPct)}
          tone={m.returnPct >= 0 ? 'buy' : 'sell'}
        />
        <Stat label="Mejor patrón" value={m.bestPattern ?? '—'} sub={m.worstPattern ? `peor: ${m.worstPattern}` : undefined} />
      </div>

      <EquityChart
        points={m.equityCurve.map((p) => ({ ts: p.ts, value: p.balance }))}
        baseline={result.params.initialBalance}
        formatValue={(v) => `$${fmtMoney(v, 0)}`}
      />

      <div className="admin__cols">
        <div>
          <h5 className="admin__h5">Por patrón</h5>
          <div className="admin-table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Patrón</th>
                  <th className="ta-r">Trades</th>
                  <th className="ta-r">Win rate</th>
                  <th className="ta-r">Neto</th>
                  <th className="ta-r">Expect.</th>
                </tr>
              </thead>
              <tbody>
                {m.byPattern.map((p) => (
                  <tr key={p.pattern}>
                    <td>{p.pattern}</td>
                    <td className="ta-r num">{p.trades}</td>
                    <td className="ta-r num">{fmtWinRate(p.winRate)}</td>
                    <td className={`ta-r num ${p.netR >= 0 ? 'buy-ink' : 'sell-ink'}`}>{fmtR(p.netR)}</td>
                    <td className="ta-r num">{fmtR(p.expectancyR)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h5 className="admin__h5">Por mes</h5>
          <div className="admin-table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Mes</th>
                  <th className="ta-r">Trades</th>
                  <th className="ta-r">W/L</th>
                  <th className="ta-r">Neto</th>
                </tr>
              </thead>
              <tbody>
                {m.monthly.map((mo) => (
                  <tr key={mo.month}>
                    <td className="num">{mo.month}</td>
                    <td className="ta-r num">{mo.trades}</td>
                    <td className="ta-r num">{mo.wins}/{mo.losses}</td>
                    <td className={`ta-r num ${mo.netR >= 0 ? 'buy-ink' : 'sell-ink'}`}>{fmtR(mo.netR)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {trades.length > 0 && (
        <div>
          <h5 className="admin__h5">
            Trades {trades.length > MAX_TRADE_ROWS ? `(primeros ${MAX_TRADE_ROWS} de ${trades.length})` : `(${trades.length})`}
          </h5>
          <div className="admin-table-wrap admin-table-wrap--tall">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Patrón</th>
                  <th>Dir.</th>
                  <th className="ta-r">Entrada</th>
                  <th className="ta-r">RR</th>
                  <th>Cierre</th>
                  <th className="ta-r">R</th>
                </tr>
              </thead>
              <tbody>
                {trades.slice(0, MAX_TRADE_ROWS).map((t, i) => (
                  <tr key={`${t.ts}-${i}`}>
                    <td className="num">{fmtTs(t.ts)}</td>
                    <td>{t.pattern}</td>
                    <td>
                      <span className={`dir dir--sm ${t.direction === 'buy' ? 'dir--buy' : 'dir--sell'}`}>
                        {t.direction === 'buy' ? 'LONG' : 'SHORT'}
                      </span>
                    </td>
                    <td className="ta-r num">{t.entry}</td>
                    <td className="ta-r num">{fmtMoney(t.rr, 1)}</td>
                    <td>
                      <span className={`chip ${t.outcome === 'tp_hit' ? 'chip--buy' : t.outcome === 'sl_hit' ? 'chip--sell' : 'chip--ghost'}`}>
                        {t.outcome === 'tp_hit' ? 'TP' : t.outcome === 'sl_hit' ? 'SL' : 'EXP'}
                      </span>
                    </td>
                    <td className={`ta-r num ${t.r >= 0 ? 'buy-ink' : 'sell-ink'}`}>{fmtR(t.r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'buy' | 'sell' }) {
  return (
    <div className="bt-stat">
      <label>{label}</label>
      <b className={`num ${tone === 'buy' ? 'buy-ink' : tone === 'sell' ? 'sell-ink' : ''}`}>{value}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
}
