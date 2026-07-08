import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, getToken, setToken, UNAUTHORIZED_EVENT, type ApiUser } from '../api/client';
import { OrionMark } from '../components/icons';
import { AuthContext } from './useAuth';

/* Puerta de autenticación: nada de la app se monta (ni pide datos al
   worker) hasta que hay sesión válida. El token vive en localStorage y
   viaja como Bearer en cada petición (ver api/client.ts); si el worker
   devuelve 401 en cualquier momento, se vuelve a esta pantalla. */

type Status = 'checking' | 'anon' | 'authed';

export default function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(() => (getToken() ? 'checking' : 'anon'));
  const [user, setUser] = useState<ApiUser | null>(null);

  // valida el token guardado al arrancar
  useEffect(() => {
    if (status !== 'checking') return;
    let cancelled = false;
    api
      .me()
      .then(({ user }) => {
        if (cancelled) return;
        setUser(user);
        setStatus('authed');
      })
      .catch(() => {
        if (cancelled) return;
        setToken(null);
        setStatus('anon');
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  // el cliente API avisa cuando cualquier petición devuelve 401
  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      setStatus('anon');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const logout = useCallback(() => {
    api.logout().catch(() => {}); // invalida la sesión en D1; en local se cierra igual
    setToken(null);
    setUser(null);
    setStatus('anon');
  }, []);

  if (status === 'checking') {
    return (
      <div className="auth">
        <div className="auth__card auth__card--quiet">
          <OrionMark size={30} />
          <p className="auth__hint">Restaurando sesión…</p>
        </div>
      </div>
    );
  }

  if (status === 'anon' || !user) {
    return (
      <LoginScreen
        onAuthed={(u) => {
          setUser(u);
          setStatus('authed');
        }}
      />
    );
  }

  return <AuthContext value={{ user, logout }}>{children}</AuthContext>;
}

function LoginScreen({ onAuthed }: { onAuthed: (user: ApiUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session =
        mode === 'login' ? await api.login(email, password) : await api.register(email, password);
      setToken(session.token);
      onAuthed(session.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error inesperado');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit}>
        <div className="auth__brand">
          <OrionMark size={30} />
          <div className="topbar__word">
            <span className="topbar__name">ORION</span>
            <span className="topbar__sub">MARKETS</span>
          </div>
        </div>

        <h1 className="auth__title">
          {mode === 'login' ? 'Inicia sesión' : 'Crea tu cuenta'}
        </h1>

        <label className="auth__field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus
          />
        </label>

        <label className="auth__field">
          <span>Contraseña</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={8}
            required
          />
        </label>

        {error && <p className="auth__error">{error}</p>}

        <button className="auth__submit" type="submit" disabled={busy}>
          {busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Registrarme'}
        </button>

        <button
          type="button"
          className="auth__switch"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login'
            ? '¿Primera vez? Crea una cuenta'
            : '¿Ya tienes cuenta? Inicia sesión'}
        </button>
      </form>
    </div>
  );
}
