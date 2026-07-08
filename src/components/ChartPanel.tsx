import { useEffect, useMemo, useRef, useState } from 'react';
import MainChart, { type ChartKind, type Indicators } from './MainChart';
import {
  TIMEFRAMES, pairBySymbol, quoteFromCandles, fmtPct, fmtPips,
  type AISignal, type SeriesData,
} from '../data/market';
import { isLiveCapable } from '../data/live';
import {
  AreaIcon, CandlesIcon, LayersIcon, LineIcon, OhlcIcon, SparkleIcon, TargetIcon,
} from './icons';

interface Props {
  symbol: string;
  tf: string;
  onTfChange: (tf: string) => void;
  activeSignal: AISignal | null;
  onExitSignal: () => void;
  series: SeriesData | null;
  signals: AISignal[];
  live: boolean;
  loading: boolean;
}

const KINDS: { id: ChartKind; label: string; icon: typeof CandlesIcon }[] = [
  { id: 'candlestick', label: 'Velas', icon: CandlesIcon },
  { id: 'ohlc', label: 'Barras OHLC', icon: OhlcIcon },
  { id: 'line', label: 'Línea', icon: LineIcon },
  { id: 'area', label: 'Área', icon: AreaIcon },
];

/* Indicadores disponibles; se activan uno a uno desde el desplegable. */
const INDICATORS: { id: keyof Indicators; label: string; color: string }[] = [
  { id: 'ema20', label: 'EMA 20', color: 'var(--series-1)' },
  { id: 'ema50', label: 'EMA 50', color: 'var(--series-2)' },
  { id: 'rsi14', label: 'RSI 14', color: 'var(--series-3)' },
];

/* Qué señales se pintan sobre el gráfico. Por defecto solo las activas:
   las cerradas (TP/SL/expiradas) se consultan con el filtro. */
type SignalFilter = 'activas' | 'tp' | 'sl' | 'ia' | 'todas';

const SIGNAL_FILTERS: { id: SignalFilter; label: string; title: string }[] = [
  { id: 'activas', label: 'Activas', title: 'Señales aún abiertas' },
  { id: 'tp', label: 'TP', title: 'Cerradas en take profit' },
  { id: 'sl', label: 'SL', title: 'Cerradas en stop loss' },
  { id: 'ia', label: 'IA', title: 'Con análisis de la IA' },
  { id: 'todas', label: 'Todas', title: 'Todas las señales recientes' },
];

function matchesFilter(s: AISignal, f: SignalFilter): boolean {
  switch (f) {
    case 'activas': return s.outcome === 'open';
    case 'tp': return s.outcome === 'tp_hit';
    case 'sl': return s.outcome === 'sl_hit';
    case 'ia': return s.overallScore != null;
    case 'todas': return true;
  }
}

export default function ChartPanel({
  symbol, tf, onTfChange, activeSignal, onExitSignal, series, signals, live, loading,
}: Props) {
  const [kind, setKind] = useState<ChartKind>('candlestick');
  const [showSignals, setShowSignals] = useState(true);
  const [signalFilter, setSignalFilter] = useState<SignalFilter>('activas');
  const [indicators, setIndicators] = useState<Indicators>({
    ema20: true,
    ema50: true,
    rsi14: true,
  });

  /* Desplegable de indicadores. La toolbar hace scroll horizontal (recorta
     lo posicionado dentro), así que el menú va en `fixed` anclado al botón. */
  const [indMenu, setIndMenu] = useState<{ top: number; right: number } | null>(null);
  const indBtnRef = useRef<HTMLButtonElement>(null);
  const indMenuRef = useRef<HTMLDivElement>(null);

  const toggleIndMenu = () => {
    if (indMenu) {
      setIndMenu(null);
      return;
    }
    const r = indBtnRef.current?.getBoundingClientRect();
    if (r) setIndMenu({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };

  useEffect(() => {
    if (!indMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (indMenuRef.current?.contains(t) || indBtnRef.current?.contains(t)) return;
      setIndMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIndMenu(null);
    };
    const onResize = () => setIndMenu(null);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [indMenu]);

  const toggleIndicator = (id: keyof Indicators) =>
    setIndicators((prev) => ({ ...prev, [id]: !prev[id] }));

  const activeIndicators = INDICATORS.filter((i) => indicators[i.id]).length;

  // señales que pasan el filtro; la señal enfocada se pinta siempre
  const visibleSignals = useMemo(() => {
    const out = signals.filter((s) => matchesFilter(s, signalFilter));
    if (activeSignal && !out.some((s) => s.id === activeSignal.id)) {
      out.push(activeSignal);
    }
    return out;
  }, [signals, signalFilter, activeSignal]);

  const pair = pairBySymbol(symbol);
  const tfMinutes = TIMEFRAMES.find((t) => t.id === tf)?.minutes ?? 60;
  const hasData = series !== null && series.candles.length >= 2;
  const quote = hasData ? quoteFromCandles(symbol, series.candles, tfMinutes) : null;
  const up = (quote?.changePct ?? 0) >= 0;

  // el último dígito significativo del precio se resalta como "pipeta"
  const bid = quote?.bid.toFixed(pair.decimals);
  const bidHead = bid?.slice(0, -1);
  const bidPip = bid?.slice(-1);

  return (
    <section className="chart-panel panel">
      <div className="chart-head">
        <div className="chart-head__pair">
          <h1>
            {pair.base}
            <em>/{pair.quote}</em>
          </h1>
          <span className="chart-head__name">
            {pair.name} · Forex
            <span className={`src-badge ${live ? 'src-badge--live' : ''}`}>
              {live ? '● EN VIVO' : loading ? '◌ CARGANDO' : '○ SIN DATOS'}
            </span>
          </span>
        </div>

        <div className="chart-head__quote">
          {quote ? (
            <>
              <div className={`bigprice num ${up ? 'bigprice--up' : 'bigprice--down'}`}>
                {bidHead}
                <sup>{bidPip}</sup>
              </div>
              <div className="chart-head__meta">
                <span className={`chip num ${up ? 'chip--buy' : 'chip--sell'}`}>
                  {up ? '▲' : '▼'} {fmtPct(quote.changePct)} · {fmtPips(quote.changePips)} pips
                </span>
                <span className="kv num">
                  <label>Venta</label> {quote.bid.toFixed(pair.decimals)}
                </span>
                <span className="kv num">
                  <label>Compra</label> {quote.ask.toFixed(pair.decimals)}
                </span>
                <span className="kv num">
                  <label>Spread</label> {pair.spread.toFixed(1)}
                </span>
                <span className="kv num">
                  <label>Máx</label> {quote.high.toFixed(pair.decimals)}
                </span>
                <span className="kv num">
                  <label>Mín</label> {quote.low.toFixed(pair.decimals)}
                </span>
              </div>
            </>
          ) : (
            <div className="bigprice num">—</div>
          )}
        </div>

        <div className="chart-head__trade">
          <button className="trade-btn trade-btn--sell" disabled={!quote}>
            <span>VENDER</span>
            <span className="num">{quote ? quote.bid.toFixed(pair.decimals) : '—'}</span>
          </button>
          <button className="trade-btn trade-btn--buy" disabled={!quote}>
            <span>COMPRAR</span>
            <span className="num">{quote ? quote.ask.toFixed(pair.decimals) : '—'}</span>
          </button>
        </div>
      </div>

      <div className="chart-toolbar">
        <div className="seg">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.id}
              className={`seg__btn num ${tf === t.id ? 'seg__btn--on' : ''}`}
              disabled={!isLiveCapable(symbol, t.id)}
              title={isLiveCapable(symbol, t.id) ? undefined : 'Sin cobertura del motor'}
              onClick={() => onTfChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <span className="toolbar-sep" />

        <div className="seg">
          {KINDS.map((k) => {
            const Icon = k.icon;
            return (
              <button
                key={k.id}
                title={k.label}
                className={`seg__btn seg__btn--icon ${kind === k.id ? 'seg__btn--on' : ''}`}
                onClick={() => setKind(k.id)}
              >
                <Icon size={14} />
              </button>
            );
          })}
        </div>

        <span className="toolbar-sep" />

        <button
          ref={indBtnRef}
          className={`tool-toggle ${indMenu ? 'tool-toggle--on' : ''}`}
          aria-haspopup="menu"
          aria-expanded={indMenu !== null}
          onClick={toggleIndMenu}
        >
          <LayersIcon size={13} /> Indicadores
          <span className="num">{activeIndicators}</span>
        </button>
        {indMenu && (
          <div
            ref={indMenuRef}
            className="ind-menu"
            role="menu"
            style={{ top: indMenu.top, right: indMenu.right }}
          >
            {INDICATORS.map((ind) => {
              const on = indicators[ind.id];
              return (
                <button
                  key={ind.id}
                  className={`ind-menu__row ${on ? '' : 'ind-menu__row--off'}`}
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => toggleIndicator(ind.id)}
                >
                  <i className="dot" style={{ background: ind.color }} />
                  {ind.label}
                  <span className={`switch ${on ? 'switch--on' : ''}`}>
                    <span className="switch__knob" />
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <span className="toolbar-spacer" />

        {activeSignal && (
          <button
            className={`signal-focus-chip ${activeSignal.direction === 'buy' ? 'signal-focus-chip--buy' : 'signal-focus-chip--sell'}`}
            title="Salir de la señal"
            onClick={onExitSignal}
          >
            <TargetIcon size={12} />
            Señal {activeSignal.direction === 'buy' ? 'COMPRA' : 'VENTA'}
            <span className="num">{activeSignal.symbol} · {activeSignal.tf}</span>
            <span className="signal-focus-chip__x">✕</span>
          </button>
        )}

        {showSignals && (
          <div className="seg">
            {SIGNAL_FILTERS.map((f) => (
              <button
                key={f.id}
                title={f.title}
                className={`seg__btn ${signalFilter === f.id ? 'seg__btn--on' : ''}`}
                onClick={() => setSignalFilter(f.id)}
              >
                {f.label}
                <span className="num"> {signals.filter((s) => matchesFilter(s, f.id)).length}</span>
              </button>
            ))}
          </div>
        )}

        <button
          className={`tool-toggle tool-toggle--ai ${showSignals ? 'tool-toggle--on' : ''}`}
          onClick={() => setShowSignals((v) => !v)}
        >
          <SparkleIcon size={13} /> Patrones IA
        </button>
      </div>

      <div className="chart-body">
        {hasData ? (
          <MainChart
            symbol={symbol}
            tf={tf}
            kind={kind}
            showSignals={showSignals}
            indicators={indicators}
            activeSignal={activeSignal}
            series={series}
            signals={visibleSignals}
          />
        ) : (
          <div className="chart-empty">
            <span className="belt-dots" aria-hidden="true">
              <i /><i /><i />
            </span>
            {loading
              ? `Cargando ${symbol} ${tf} desde el motor…`
              : isLiveCapable(symbol, tf)
                ? `El motor aún no tiene histórico de ${symbol} en ${tf}`
                : `${symbol} ${tf} está fuera del universo del motor`}
          </div>
        )}
      </div>
    </section>
  );
}
