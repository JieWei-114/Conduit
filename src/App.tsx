import { useEffect, useState } from 'react';
import GrpcPanel from './GrpcPanel';
import HttpPanel from './HttpPanel';
import RedisPanel from './RedisPanel';
import DbPanel from './DbPanel';
import KafkaPanel from './KafkaPanel';
import PulsarPanel from './PulsarPanel';
import WsPanel from './WsPanel';
import WebhookPanel from './WebhookPanel';
import DiagPanel from './DiagPanel';
import UtilsPanel from './UtilsPanel';

type Tab = 'http' | 'grpc' | 'db' | 'redis' | 'ws' | 'pulsar' | 'kafka' | 'webhook' | 'diag' | 'utils';

const LS_TAB = 'conduit.tab.v1';
const LS_THEME = 'conduit.theme.v1';

type Theme = 'auto' | 'light' | 'dark';

const THEMES: { id: Theme; label: string; title: string }[] = [
  { id: 'auto', label: 'Auto', title: 'Follow the system appearance' },
  { id: 'light', label: 'Light', title: 'Always light' },
  { id: 'dark', label: 'Dark', title: 'Always dark' },
];

/* `auto` removes the attribute rather than writing a value, which hands the
   decision back to the `prefers-color-scheme` blocks in the stylesheet. */
function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

/* Tab order is the order of the ⌘1..⌘0 shortcuts, so it is also the order the
   panels render in. Every panel is listed here exactly once and mounted from
   this list, which keeps the shortcut index, the tab bar and the panel stack
   from drifting apart. */
const TABS: { id: Tab; label: string; Panel: () => JSX.Element }[] = [
  { id: 'http', label: 'HTTP', Panel: HttpPanel },
  { id: 'grpc', label: 'gRPC', Panel: GrpcPanel },
  { id: 'db', label: 'DB', Panel: DbPanel },
  { id: 'redis', label: 'Redis', Panel: RedisPanel },
  { id: 'ws', label: 'WS/SSE', Panel: WsPanel },
  { id: 'pulsar', label: 'Pulsar', Panel: PulsarPanel },
  { id: 'kafka', label: 'Kafka', Panel: KafkaPanel },
  { id: 'webhook', label: 'Webhook', Panel: WebhookPanel },
  { id: 'diag', label: 'Diag', Panel: DiagPanel },
  { id: 'utils', label: 'Utils', Panel: UtilsPanel },
];

const MOD = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+';

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = localStorage.getItem(LS_TAB) as Tab;
    return TABS.some((x) => x.id === t) ? t : 'http';
  });

  const [theme, setTheme] = useState<Theme>(() => {
    const t = localStorage.getItem(LS_THEME) as Theme;
    return THEMES.some((x) => x.id === t) ? t : 'auto';
  });

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  const select = (t: Tab) => {
    setTab(t);
    localStorage.setItem(LS_TAB, t);
  };

  // Cmd/Ctrl+1..9,0 jumps between panels. The tenth tab takes 0, the way
  // browsers number their tab shortcuts, and the hint is in each tab's tooltip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const i = e.key === '0' ? 9 : Number(e.key) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= TABS.length) return;
      e.preventDefault();
      select(TABS[i].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const resetAll = async () => {
    if (!confirm('Clear ALL saved data (connections, history, forms)?')) return;
    localStorage.clear();
    await fetch('/api/store', { method: 'DELETE' }).catch(() => {});
    location.reload();
  };

  // panels stay mounted so live feeds / in-flight requests survive tab switches
  return (
    <div className="app">
      <header className="topbar" role="tablist" aria-label="Protocol">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span className="brand-text">Conduit</span>
        </span>
        {TABS.map((t, i) => (
          <span
            key={t.id}
            className={`toptab ${tab === t.id ? 'active' : ''}`}
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={0}
            title={`${t.label} (${MOD}${i === 9 ? 0 : i + 1})`}
            onClick={() => select(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') select(t.id);
            }}
          >
            {t.label}
          </span>
        ))}
        <span className="toptab reset-all" title="Clear all saved data" onClick={resetAll}>
          reset data
        </span>
        <div className="theme-seg" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={theme === t.id ? 'on' : undefined}
              title={t.title}
              aria-pressed={theme === t.id}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <main className="panel">
        {TABS.map((t) => (
          <div
            key={t.id}
            className="panel-slot"
            role="tabpanel"
            aria-label={t.label}
            hidden={tab !== t.id}
          >
            <t.Panel />
          </div>
        ))}
      </main>
    </div>
  );
}
