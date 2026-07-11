import { useCallback, useEffect, useState } from 'react';

/* Enrutado mínimo por pathname (History API): suficiente para
   / (terminal) y /admin sin añadir dependencias. Cloudflare Pages
   sirve index.html en rutas no estáticas (public/_redirects). */

export function useRoute(): { path: string; navigate: (to: string) => void } {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) {
      window.history.pushState(null, '', to);
    }
    setPath(to);
  }, []);

  return { path, navigate };
}
