import { useEffect, useMemo, useState } from 'react';
import { PAIRS, getQuote, fmtPct, type Group, type Quote } from '../data/market';
import { loadLiveQuote } from '../data/live';
import Sparkline from './Sparkline';
import { SearchIcon } from './icons';

interface Props {
  selected: string;
  onSelect: (symbol: string) => void;
}

const GROUPS: (Group | 'Todos')[] = ['Todos', 'Mayores', 'Menores', 'Exóticos'];

export default function Watchlist({ selected, onSelect }: Props) {
  const [group, setGroup] = useState<(typeof GROUPS)[number]>('Todos');
  const [query, setQuery] = useState('');
  const [liveQuotes, setLiveQuotes] = useState<Record<string, Quote>>({});

  // cotizaciones reales para los pares que cubre el motor
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const updates: Record<string, Quote> = {};
      await Promise.all(
        PAIRS.map(async (p) => {
          const q = await loadLiveQuote(p.symbol);
          if (q) updates[p.symbol] = q;
        }),
      );
      if (alive && Object.keys(updates).length > 0) setLiveQuotes(updates);
    };
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const rows = useMemo(() => {
    return PAIRS.filter(
      (p) =>
        (group === 'Todos' || p.group === group) &&
        (query === '' ||
          p.symbol.toLowerCase().includes(query.toLowerCase()) ||
          p.name.toLowerCase().includes(query.toLowerCase())),
    ).map((p) => ({
      pair: p,
      quote: liveQuotes[p.symbol] ?? getQuote(p.symbol),
      live: p.symbol in liveQuotes,
    }));
  }, [group, query, liveQuotes]);

  return (
    <aside className="watchlist panel">
      <div className="watchlist__search">
        <SearchIcon size={13} />
        <input
          placeholder="Buscar par…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="seg watchlist__groups">
        {GROUPS.map((g) => (
          <button
            key={g}
            className={`seg__btn ${group === g ? 'seg__btn--on' : ''}`}
            onClick={() => setGroup(g)}
          >
            {g}
          </button>
        ))}
      </div>

      <div className="watchlist__rows">
        {rows.map(({ pair, quote, live }) => {
          const up = quote.changePct >= 0;
          return (
            <button
              key={pair.symbol}
              className={`wrow ${selected === pair.symbol ? 'wrow--on' : ''}`}
              onClick={() => onSelect(pair.symbol)}
            >
              <div className="wrow__id">
                <span className="wrow__sym">
                  {pair.base}
                  <em>/{pair.quote}</em>
                  {live && <i className="live-dot" title="Datos del motor" />}
                </span>
                <span className="wrow__name">{pair.name}</span>
              </div>
              <Sparkline
                data={quote.spark}
                stroke={up ? 'var(--buy)' : 'var(--sell)'}
                fill={up ? 'var(--buy-glow)' : 'var(--sell-glow)'}
                width={64}
                height={22}
              />
              <div className="wrow__quote">
                <span className="wrow__price num">{quote.bid.toFixed(pair.decimals)}</span>
                <span className={`chip num ${up ? 'chip--buy' : 'chip--sell'}`}>
                  {up ? '▲' : '▼'} {fmtPct(quote.changePct)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="watchlist__foot">
        <span className="belt-dots" aria-hidden="true">
          <i /><i /><i />
        </span>
        {rows.length} instrumentos · datos simulados
      </div>
    </aside>
  );
}
