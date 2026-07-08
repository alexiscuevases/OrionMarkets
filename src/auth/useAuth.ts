import { createContext, use } from 'react';
import type { ApiUser } from '../api/client';

export interface AuthState {
  user: ApiUser;
  logout: () => void;
}

export const AuthContext = createContext<AuthState | null>(null);

/** Usuario autenticado actual; solo disponible bajo <AuthGate>. */
export function useAuth(): AuthState {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthGate>');
  return ctx;
}
