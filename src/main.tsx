import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { reportSaved, reportSaveFailed } from './storeStatus';
import { flushPending, isDiscarded, onDiscard } from './ui';
import './style.css';

/** localStorage is hydrated from the server's store on boot and mirrored back to it on every write. */
async function boot() {
  try {
    const blob = await fetch('/api/store').then((r) => r.json());
    if (blob && typeof blob === 'object')
      for (const [k, v] of Object.entries(blob))
        if (typeof v === 'string') localStorage.setItem(k, v);
  } catch {
    /* no server store yet: plain localStorage */
  }

  // index.html applies the cached theme early; the stored one only settles here, after hydration
  const savedTheme = localStorage.getItem('conduit.theme.v1');
  if (savedTheme === 'light' || savedTheme === 'dark')
    document.documentElement.setAttribute('data-theme', savedTheme);
  else document.documentElement.removeAttribute('data-theme');

  const origSet = localStorage.setItem.bind(localStorage);
  const origRemove = localStorage.removeItem.bind(localStorage);
  const KEEPALIVE_MAX = 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = '';
  let inflight: { body: string; done: Promise<void> } | null = null;

  const snapshot = () => {
    const all: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      all[k] = localStorage.getItem(k)!;
    }
    return JSON.stringify(all);
  };

  const puts = new Set<Promise<void>>();
  const put = (body: string, flushId?: number): Promise<void> => {
    const p = send(body, flushId).finally(() => puts.delete(p));
    puts.add(p);
    return p;
  };

  const send = (body: string, flushId?: number): Promise<void> =>
    fetch(flushId ? `/api/store?flush=${flushId}` : '/api/store', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: new Blob([body]).size < KEEPALIVE_MAX,
    })
      .then(async (r) => {
        if (r.status === 413)
          return reportSaveFailed(
            'the saved data is too large for the server to accept; clear some history and try again',
            saveSoon,
          );
        const j = r.ok ? await r.json().catch(() => null) : null;
        if (j?.ok) {
          lastSaved = body;
          reportSaved();
        } else reportSaveFailed(j?.error ?? `the server answered ${r.status} ${r.statusText}`.trim(), saveSoon);
      })
      .catch((e) => reportSaveFailed(`Conduit's server did not answer (${e?.message ?? e})`, saveSoon));

  const saveNow = (flushId?: number): Promise<void> => {
    if (isDiscarded()) return Promise.resolve();
    flushPending();
    clearTimeout(timer);
    timer = undefined;
    const body = snapshot();
    if (!flushId && body === lastSaved) return Promise.resolve();
    if (!flushId && inflight?.body === body) return inflight.done;
    const done = put(body, flushId).finally(() => {
      if (inflight?.done === done) inflight = null;
    });
    inflight = { body, done };
    return done;
  };

  function saveSoon() {
    if (isDiscarded()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      put(snapshot());
    }, 400);
  }

  onDiscard(() => {
    clearTimeout(timer);
    timer = undefined;
    return Promise.all(puts).then(() => undefined);
  });

  localStorage.setItem = (k, v) => {
    if (isDiscarded()) return;
    origSet(k, v);
    saveSoon();
  };
  localStorage.removeItem = (k) => {
    if (isDiscarded()) return;
    origRemove(k);
    saveSoon();
  };

  (window as unknown as { __conduitFlush: (id?: number) => Promise<void> }).__conduitFlush = saveNow;
  // a beacon is still delivered after the page is gone, which a fetch is not guaranteed to be
  const beacon = () => {
    if (isDiscarded() || typeof navigator.sendBeacon !== 'function') return;
    flushPending();
    const body = snapshot();
    if (body === lastSaved) return;
    try {
      navigator.sendBeacon('/api/store', new Blob([body], { type: 'application/json' }));
    } catch {
      /* the PUT below still runs */
    }
  };
  const leaving = () => {
    beacon();
    void saveNow();
  };
  window.addEventListener('pagehide', leaving);
  window.addEventListener('beforeunload', () => void saveNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leaving();
  });

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

boot();
