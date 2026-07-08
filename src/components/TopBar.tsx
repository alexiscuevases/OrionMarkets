import { useEffect, useState } from 'react';
import { useAuth } from '../auth/useAuth';
import { SESSIONS, isSessionOpen } from '../data/market';
import { useEngineStatus } from '../hooks/useMarketData';
import { BellIcon, GearIcon, LogoutIcon, OrionMark, SparkleIcon } from './icons';

export default function TopBar() {
  const [now, setNow] = useState(() => new Date());
  const engine = useEngineStatus();
  const { user, logout } = useAuth();

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const utc = now.toISOString().slice(11, 19);

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
            ? `MOTOR EN VIVO${engine.lastRun ? ` · ${new Date(engine.lastRun).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : ''}`
            : 'MOTOR SIN CONEXIÓN'}
        </span>
      </div>

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

      <div className="topbar__actions">
        <div className="ai-pill">
          <SparkleIcon size={13} />
          <span>Orion AI</span>
          <span className="ai-pill__dot" />
        </div>
        <button className="icon-btn" title="Alertas">
          <BellIcon size={15} />
        </button>
        <button className="icon-btn" title="Ajustes">
          <GearIcon size={15} />
        </button>
        <div className="avatar" title={user.email}>
          {user.email.slice(0, 2).toUpperCase()}
        </div>
        <button className="icon-btn" title="Cerrar sesión" onClick={logout}>
          <LogoutIcon size={15} />
        </button>
      </div>
    </header>
  );
}
