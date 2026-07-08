import { useMarketState } from '../hooks/useMarketData';
import { SESSIONS, isSessionOpen } from '../data/market';

/* Franja «Estado del mercado» bajo la cabecera del gráfico: tendencia,
   volatilidad, RSI, sesión activa y noticias del símbolo en pantalla.
   Contextualiza las señales: una misma estrategia no vale lo mismo en
   Londres con volatilidad media que en Sídney con el mercado dormido. */
export default function MarketContextBar({ symbol }: { symbol: string }) {
  const state = useMarketState(symbol);
  if (!state) return null;

  const utcHour = new Date().getUTCHours();
  const open = SESSIONS.filter((s) => isSessionOpen(s, utcHour)).map((s) => s.name);
  const session = open.length > 0 ? open.join(' + ') : 'Fuera de horario';

  const trendLabel =
    state.trend === 'lateral'
      ? 'Lateral'
      : `${cap(state.trend)}${state.trendStrength ? ` ${state.trendStrength}` : ''}`;
  const trendClass =
    state.trend === 'alcista' ? 'mctx__v--up' : state.trend === 'bajista' ? 'mctx__v--down' : '';

  return (
    <div className="mctx">
      <span className="mctx__label">Estado del mercado</span>
      <span className="mctx__item">
        <label>Tendencia H1</label>
        <b className={trendClass}>
          {state.trend === 'alcista' ? '↗' : state.trend === 'bajista' ? '↘' : '→'} {trendLabel}
        </b>
      </span>
      <span className="mctx__item">
        <label>Volatilidad</label>
        <b>{cap(state.volatility)} <em className="num">ATR {state.atrPct}%</em></b>
      </span>
      <span className="mctx__item">
        <label>RSI 14</label>
        <b className="num">{state.rsi14}</b>
      </span>
      {state.aboveEma200 !== null && (
        <span className="mctx__item">
          <label>EMA 200</label>
          <b>{state.aboveEma200 ? 'Precio por encima' : 'Precio por debajo'}</b>
        </span>
      )}
      <span className="mctx__item">
        <label>Sesión</label>
        <b>{session}</b>
      </span>
      <span className="mctx__item">
        <label>Noticias</label>
        <b>{state.news ?? 'Ninguna'}</b>
      </span>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
