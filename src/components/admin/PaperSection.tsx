import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import EquityChart from './EquityChart';
import { fmtMoney, fmtPct, fmtR, fmtTs, useAdminFetch } from './util';

/** Paper trading: cuenta virtual, posiciones abiertas, curva de equity
    y reset con parámetros nuevos (POST /api/paper/reset). */
export default function PaperSection() {
  const { data, loading, error, reload } = useAdminFetch(() => api.paperAccount());
  const [resetForm, setResetForm] = useState({ initialBalance: '10000', riskPct: '1', minScore: '65' });
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  const set = (key: keyof typeof resetForm) => (e: { target: { value: string } }) => {
    setConfirming(false);
    setResetForm((f) => ({ ...f, [key]: e.target.value }));
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    // primer clic arma la confirmación; el segundo ejecuta (borra trades)
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setResetting(true);
    setResetMsg(null);
    try {
      await api.paperReset({
        initialBalance: Number(resetForm.initialBalance) || undefined,
        riskPct: Number(resetForm.riskPct) || undefined,
        minScore: Number(resetForm.minScore) || undefined,
      });
      setResetMsg('Cuenta reseteada.');
      reload();
    } catch (err) {
      setResetMsg(err instanceof Error ? err.message : 'no se pudo resetear la cuenta');
    } finally {
      setResetting(false);
      setConfirming(false);
    }
  };

  if (loading && !data) return <p className="admin__note">Cargando cuenta paper…</p>;

  return (
    <div className="admin__stack">
      <div className="admin__row-head">
        <h3 className="admin__h">Paper trading</h3>
        <button className="ghost-btn ghost-btn--sm" onClick={reload} disabled={loading}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {error && !data && <p className="admin__note admin__note--error">{error}</p>}

      {data && (
        <>
          <div className="bt-stats">
            <Stat
              label="Balance"
              value={`$${fmtMoney(data.account.balance)}`}
              sub={`inicial $${fmtMoney(data.account.initialBalance, 0)}`}
              tone={data.stats.returnPct >= 0 ? 'buy' : 'sell'}
            />
            <Stat label="Retorno" value={fmtPct(data.stats.returnPct)} tone={data.stats.returnPct >= 0 ? 'buy' : 'sell'} />
            <Stat
              label="Trades"
              value={String(data.stats.totalTrades)}
              sub={`${data.stats.wins}W · ${data.stats.losses}L · ${data.stats.expired}exp`}
            />
            <Stat
              label="Win rate"
              value={data.stats.winRate != null ? `${Math.round(data.stats.winRate * 100)}%` : '—'}
            />
            <Stat label="Neto" value={fmtR(data.stats.netR)} sub={`$${fmtMoney(data.stats.netPl)}`} />
            <Stat label="Drawdown máx." value={fmtPct(data.stats.maxDrawdownPct)} tone="sell" />
            <Stat
              label="Config"
              value={`${data.account.riskPct}% / trade`}
              sub={`score mín. ${data.account.minScore} · máx. ${data.account.maxOpenPositions} pos.`}
            />
          </div>

          <EquityChart
            points={data.equityCurve.map((p) => ({ ts: p.ts, value: p.balance }))}
            baseline={data.account.initialBalance}
            formatValue={(v) => `$${fmtMoney(v, 0)}`}
          />

          <section className="admin-card">
            <h4 className="admin__h4">Posiciones abiertas ({data.openPositions.length})</h4>
            <div className="admin-table-wrap">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Par</th>
                    <th>Int.</th>
                    <th>Dir.</th>
                    <th className="ta-r">Entrada</th>
                    <th className="ta-r">Stop</th>
                    <th className="ta-r">Target</th>
                    <th className="ta-r">Riesgo</th>
                    <th>Abierta</th>
                  </tr>
                </thead>
                <tbody>
                  {data.openPositions.map((p) => (
                    <tr key={p.sigKey}>
                      <td className="strong">{p.symbol}</td>
                      <td className="num">{p.interval}</td>
                      <td>
                        <span className={`dir dir--sm ${p.direction === 'buy' ? 'dir--buy' : 'dir--sell'}`}>
                          {p.direction === 'buy' ? 'LONG' : 'SHORT'}
                        </span>
                      </td>
                      <td className="ta-r num">{p.entry}</td>
                      <td className="ta-r num">{p.stop}</td>
                      <td className="ta-r num">{p.target}</td>
                      <td className="ta-r num">${fmtMoney(p.riskAmount)} ({p.riskPct}%)</td>
                      <td className="num">{fmtTs(p.openedAt)}</td>
                    </tr>
                  ))}
                  {data.openPositions.length === 0 && (
                    <tr><td colSpan={8} className="dim">Sin posiciones abiertas</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="admin-card">
        <h4 className="admin__h4">Resetear cuenta</h4>
        <p className="admin__note">
          Borra posiciones, órdenes y trades de la cuenta virtual y restaura el balance
          con los parámetros indicados. Irreversible.
        </p>
        <form className="admin-form" onSubmit={reset}>
          <label className="afield">
            Balance inicial (USD)
            <input type="number" min="100" max="10000000" step="100" value={resetForm.initialBalance} onChange={set('initialBalance')} />
          </label>
          <label className="afield">
            Riesgo por trade (%)
            <input type="number" min="0.1" max="10" step="0.1" value={resetForm.riskPct} onChange={set('riskPct')} />
          </label>
          <label className="afield">
            Score mínimo
            <input type="number" min="0" max="100" step="5" value={resetForm.minScore} onChange={set('minScore')} />
          </label>
          <button
            className={`admin-btn ${confirming ? 'admin-btn--danger' : ''}`}
            type="submit"
            disabled={resetting}
          >
            {resetting ? 'Reseteando…' : confirming ? 'Confirmar reset (borra el historial)' : 'Resetear cuenta'}
          </button>
        </form>
        {resetMsg && <p className="admin__note">{resetMsg}</p>}
      </section>
    </div>
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
