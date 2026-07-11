import { useEffect, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import type { Theme } from '../theme';
import { SESSIONS, isSessionOpen } from '../data/market';
import { useEngineStatus } from '../hooks/useMarketData';
import {
  BellIcon, ChevronDown, LogoutIcon, MoonIcon, OrionMark, ShieldIcon, SparkleIcon, SunIcon,
} from './icons';

interface Props {
  /** Vista admin activa; el enlace del menú vuelve al terminal. */
  adminOpen: boolean;
  /** Navegación admin ↔ terminal; undefined cuando el usuario no es admin. */
  onToggleAdmin?: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

type Menu = 'sessions' | 'bell' | 'user' | null;

const fmtUtcHour = (h: number) => `${String(h).padStart(2, '0')}:00`;

export default function TopBar({ adminOpen, onToggleAdmin, theme, onToggleTheme }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [menu, setMenu] = useState<Menu>(null);
  const engine = useEngineStatus();
  const { user, logout } = useAuth();

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // los dropdowns se cierran al pulsar fuera o con Escape
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!t.closest('.dd')) setMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const utc = now.toISOString().slice(11, 19);
  const openCount = SESSIONS.filter((s) => isSessionOpen(s, utcHour)).length;
  const lastRun = engine.lastRun
    ? new Date(engine.lastRun).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : null;

  const toggle = (m: Exclude<Menu, null>) => setMenu((prev) => (prev === m ? null : m));

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <OrionMark size={26} />
        <div className="topbar__word">
          <span className="topbar__name">ORION</span>
          <span className="topbar__sub">MARKETS</span>
        </div>
        <span className={`topbar__env ${engine.status === 'online' ? 'topbar__env--live' : ''}`}>
          {engine.status === 'online'
            ? `MOTOR EN VIVO${lastRun ? ` · ${lastRun}` : ''}`
            : 'MOTOR SIN CONEXIÓN'}
        </span>
      </div>

      {/* Reloj UTC + sesiones de mercado, plegados en un desplegable */}
      <div className="dd topbar__sessions">
        <button
          className={`sessions-btn ${menu === 'sessions' ? 'sessions-btn--on' : ''}`}
          title="Sesiones de mercado"
          aria-haspopup="menu"
          aria-expanded={menu === 'sessions'}
          onClick={() => toggle('sessions')}
        >
          <span className={`session__dot ${openCount > 0 ? 'session__dot--open' : ''}`} />
          <span>{openCount} {openCount === 1 ? 'sesión' : 'sesiones'}</span>
          <span className="sessions-btn__clock num">{utc} UTC</span>
          <ChevronDown size={12} />
        </button>
        {menu === 'sessions' && (
          <div className="dd__menu dd__menu--sessions" role="menu">
            <div className="dd__head">Sesiones de mercado</div>
            {SESSIONS.map((s) => {
              const open = isSessionOpen(s, utcHour);
              return (
                <div key={s.name} className={`dd__session ${open ? 'dd__session--open' : ''}`}>
                  <span className="session__dot" />
                  <span className="dd__session-name">{s.name}</span>
                  <span className="dd__session-hours num">
                    {fmtUtcHour(s.openUtc)}–{fmtUtcHour(s.closeUtc)} UTC
                  </span>
                  <em>{open ? 'Abierta' : 'Cerrada'}</em>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="topbar__actions">
        <div className="ai-pill">
          <SparkleIcon size={13} />
          <span>Orion AI</span>
          <span className="ai-pill__dot" />
        </div>

        {/* Tema claro/oscuro */}
        <button
          className="icon-btn"
          title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
        </button>

        {/* Notificaciones */}
        <div className="dd">
          <button
            className={`icon-btn ${menu === 'bell' ? 'icon-btn--on' : ''}`}
            title="Notificaciones"
            aria-haspopup="menu"
            aria-expanded={menu === 'bell'}
            onClick={() => toggle('bell')}
          >
            <BellIcon size={15} />
            {engine.status !== 'online' && <span className="icon-btn__dot" />}
          </button>
          {menu === 'bell' && (
            <div className="dd__menu" role="menu">
              <div className="dd__head">Notificaciones</div>
              <div className="dd__row">
                <span
                  className={`dd__status-dot ${engine.status === 'online' ? 'dd__status-dot--ok' : 'dd__status-dot--bad'}`}
                />
                <div>
                  <b>{engine.status === 'online' ? 'Motor en vivo' : 'Motor sin conexión'}</b>
                  <p>
                    {engine.status === 'online'
                      ? lastRun
                        ? `Última ejecución del pipeline a las ${lastRun}`
                        : 'Esperando la primera ejecución del pipeline'
                      : 'No se pudo contactar con el worker'}
                  </p>
                </div>
              </div>
              <div className="dd__empty">No hay más notificaciones</div>
            </div>
          )}
        </div>

        {/* Cuenta */}
        <div className="dd">
          <button
            className={`avatar ${adminOpen ? 'avatar--admin' : ''}`}
            title={user.email}
            aria-haspopup="menu"
            aria-expanded={menu === 'user'}
            onClick={() => toggle('user')}
          >
            {user.email.slice(0, 2).toUpperCase()}
          </button>
          {menu === 'user' && (
            <div className="dd__menu" role="menu">
              <div className="dd__head">
                {user.email}
                <span className="dd__role">{user.role === 'admin' ? 'Administrador' : 'Usuario'}</span>
              </div>
              {user.role === 'admin' && onToggleAdmin && (
                <button
                  className="dd__item"
                  role="menuitem"
                  onClick={() => {
                    setMenu(null);
                    onToggleAdmin();
                  }}
                >
                  <ShieldIcon size={14} />
                  {adminOpen ? 'Volver al terminal' : 'Panel de administración'}
                </button>
              )}
              <div className="dd__sep" />
              <button
                className="dd__item dd__item--danger"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  logout();
                }}
              >
                <LogoutIcon size={14} />
                Cerrar sesión
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
