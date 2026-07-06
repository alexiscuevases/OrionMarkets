import { useState } from 'react';
import MainChart, { type ChartKind } from './MainChart';
import {
  TIMEFRAMES, getQuote, pairBySymbol, fmtPct, fmtPips, type AISignal,
} from '../data/market';
import {
  AreaIcon, CandlesIcon, LayersIcon, LineIcon, OhlcIcon, SparkleIcon,
} from './icons';

interface Props {
  symbol: string;
  tf: string;
  onTfChange: (tf: string) => void;
  activeSignal: AISignal | null;
}

const KINDS: { id: ChartKind; label: string; icon: typeof CandlesIcon }[] = [
  { id: 'candlestick', label: 'Velas', icon: CandlesIcon },
  { id: 'ohlc', label: 'Barras OHLC', icon: OhlcIcon },
  { id: 'line', label: 'Línea', icon: LineIcon },
  { id: 'area', label: 'Área', icon: AreaIcon },
];

export default function ChartPanel({ symbol, tf, onTfChange, activeSignal }: Props) {
  const [kind, setKind] = useState<ChartKind>('candlestick');
  const [showSignals, setShowSignals] = useState(true);
  const [showEMA, setShowEMA] = useState(true);
  const [showRSI, setShowRSI] = useState(true);

  const pair = pairBySymbol(symbol);
  const quote = getQuote(symbol);
  const up = quote.changePct >= 0;

  // el último dígito significativo del precio se resalta como "pipeta"
  const bid = quote.bid.toFixed(pair.decimals);
  const bidHead = bid.slice(0, -1);
  const bidPip = bid.slice(-1);

  return (
    <section className="chart-panel panel">
      <div className="chart-head">
        <div className="chart-head__pair">
          <h1>
            {pair.base}
            <em>/{pair.quote}</em>
          </h1>
          <span className="chart-head__name">{pair.name} · Forex</span>
        </div>

        <div className="chart-head__quote">
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
        </div>

        <div className="chart-head__trade">
          <button className="trade-btn trade-btn--sell">
            <span>VENDER</span>
            <span className="num">{quote.bid.toFixed(pair.decimals)}</span>
          </button>
          <button className="trade-btn trade-btn--buy">
            <span>COMPRAR</span>
            <span className="num">{quote.ask.toFixed(pair.decimals)}</span>
          </button>
        </div>
      </div>

      <div className="chart-toolbar">
        <div className="seg">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.id}
              className={`seg__btn num ${tf === t.id ? 'seg__btn--on' : ''}`}
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
          className={`tool-toggle ${showEMA ? 'tool-toggle--on' : ''}`}
          onClick={() => setShowEMA((v) => !v)}
        >
          <LayersIcon size={13} />
          <i className="dot" style={{ background: 'var(--series-1)' }} /> EMA 20
          <i className="dot" style={{ background: 'var(--series-2)' }} /> EMA 50
        </button>
        <button
          className={`tool-toggle ${showRSI ? 'tool-toggle--on' : ''}`}
          onClick={() => setShowRSI((v) => !v)}
        >
          <LayersIcon size={13} />
          <i className="dot" style={{ background: 'var(--series-3)' }} /> RSI 14
        </button>

        <span className="toolbar-spacer" />

        <button
          className={`tool-toggle tool-toggle--ai ${showSignals ? 'tool-toggle--on' : ''}`}
          onClick={() => setShowSignals((v) => !v)}
        >
          <SparkleIcon size={13} /> Patrones IA
        </button>
      </div>

      <div className="chart-body">
        <MainChart
          symbol={symbol}
          tf={tf}
          kind={kind}
          showSignals={showSignals}
          showEMA={showEMA}
          showRSI={showRSI}
          activeSignal={activeSignal}
        />
      </div>
    </section>
  );
}
