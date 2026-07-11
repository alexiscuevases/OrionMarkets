import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import type { Theme } from '../theme';
import { SESSIONS, isSessionOpen } from '../data/market';
import { useEngineStatus } from '../hooks/useMarketData';
import {
  BellIcon, LogoutIcon, MoonIcon, OrionMark, ShieldIcon, SparkleIcon, SunIcon,
} from './icons';

interface Props {
  /** Vista admin activa; el enlace del menú vuelve al terminal. */
  adminOpen: boolean;
  /** Navegación admin ↔ terminal; undefined cuando el usuario no es admin. */
  onToggleAdmin?: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

type Menu = 'bell' | 'user' | null;

export default function TopBar({ adminOpen, onToggleAdmin, theme, onToggleTheme }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [menu, setMenu] = useState<Menu>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
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
      if (!actionsRef.current?.contains(e.target as Node)) setMenu(null);
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

      {/* Sesiones de mercado + reloj UTC en un solo panel */}
      <div className="topbar__sessions">
        {SESSIONS.map((s) => {
          const open = isSessionOpen(s, utcHour);
          return (
            <div key={s.name} className={`session ${open ? 'session--open' : ''}`}>
              <span className="session__dot" />
              {s.name}
            </div>
          );
        })}
        <div className="topbar__clock num">{utc} UTC</div>
      </div>

      <div className="topbar__actions" ref={actionsRef}>
        {user.role === 'admin' && onToggleAdmin && (
          <button
            className={`admin-pill ${adminOpen ? 'admin-pill--on' : ''}`}
            title={adminOpen ? 'Volver al terminal' : 'Panel de administración'}
            onClick={onToggleAdmin}
          >
            <ShieldIcon size={13} />
            <span>Admin</span>
          </button>
        )}

        <div className="ai-pill">
          <SparkleIcon size={13} />
          <span>Orion AI</span>
          <span className="ai-pill__dot" />
        </div>

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
            className="avatar"
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
              <button className="dd__item" role="menuitem" onClick={onToggleTheme}>
                {theme === 'dark' ? <SunIcon size={14} /> : <MoonIcon size={14} />}
                {theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
              </button>
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
