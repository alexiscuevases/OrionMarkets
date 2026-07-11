import { useCallback, useState } from 'react';
import { applyOrionTheme } from './charts/orionTheme';

/* Tema claro/oscuro. El atributo data-theme de <html> lo pone un script
   inline en index.html antes de cargar el CSS (evita el destello); aquí
   solo se lee, se alterna y se persiste. */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'orion-theme';

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function persistTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* sin localStorage: el tema no sobrevive a la recarga */
  }
  // Highcharts no lee variables CSS por sí solo: re-lee los tokens
  applyOrionTheme();
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const toggleTheme = useCallback(() => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    // síncrono y antes del re-render: cuando MainChart se remonte (key)
    // las variables CSS y los tokens de Highcharts ya son los del tema nuevo
    persistTheme(next);
    setTheme(next);
  }, []);

  return { theme, toggleTheme };
}
