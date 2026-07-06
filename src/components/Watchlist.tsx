import { useMemo, useState } from 'react';
import { PAIRS, getQuote, fmtPct, type Group } from '../data/market';
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

  const rows = useMemo(() => {
    return PAIRS.filter(
      (p) =>
        (group === 'Todos' || p.group === group) &&
        (query === '' ||
          p.symbol.toLowerCase().includes(query.toLowerCase()) ||
          p.name.toLowerCase().includes(query.toLowerCase())),
    ).map((p) => ({ pair: p, quote: getQuote(p.symbol) }));
  }, [group, query]);

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
        {rows.map(({ pair, quote }) => {
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
