import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

/**
 * Persist all UI settings to a server-side file (conduit-data.json) so they
 * survive a browser cache clear. On boot we hydrate localStorage from the file,
 * then mirror every localStorage write back to the file (debounced). All panels
 * keep using localStorage as-is — this just gives it a durable, deletable home.
 */
async function boot() {
  try {
    const blob = await fetch('/api/store').then((r) => r.json());
    if (blob && typeof blob === 'object')
      for (const [k, v] of Object.entries(blob))
        if (typeof v === 'string') localStorage.setItem(k, v);
  } catch {
    /* first run / server store unavailable — fall back to plain localStorage */
  }

  /* The theme has to be applied here rather than only from the inline script in
     index.html: that script runs before this hydration, so it can only see what
     the browser happens to hold. This is the first point where the server store
     has been merged in and the saved value is authoritative. Both exist on
     purpose — the inline script avoids a flash of the wrong scheme on a warm
     load, this settles the correct one. */
  const savedTheme = localStorage.getItem('conduit.theme.v1');
  if (savedTheme === 'light' || savedTheme === 'dark')
    document.documentElement.setAttribute('data-theme', savedTheme);
  else document.documentElement.removeAttribute('data-theme');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const all: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        all[k] = localStorage.getItem(k)!;
      }
      fetch('/api/store', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(all),
      }).catch(() => {});
    }, 400);
  };

  const origSet = localStorage.setItem.bind(localStorage);
  const origRemove = localStorage.removeItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    origSet(k, v);
    save();
  };
  localStorage.removeItem = (k) => {
    origRemove(k);
    save();
  };

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

boot();
