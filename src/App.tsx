import { useEffect, useState } from 'react';
import { useArmedConfirm } from './useArmedConfirm';
import { useStoreFailure } from './storeStatus';
import { runExample, type ExampleTarget } from './examples';
import { discardPending } from './ui';
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
const LS_WELCOMED = 'conduit.welcomed.v1';

type Theme = 'auto' | 'light' | 'dark';

const THEMES: { id: Theme; label: string; title: string }[] = [
  { id: 'auto', label: 'Auto', title: 'Follow the system appearance' },
  { id: 'light', label: 'Light', title: 'Always light' },
  { id: 'dark', label: 'Dark', title: 'Always dark' },
];

function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

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
  const [welcome, setWelcome] = useState(() => !localStorage.getItem(LS_WELCOMED) && !localStorage.getItem(LS_TAB));

  const [theme, setTheme] = useState<Theme>(() => {
    const t = localStorage.getItem(LS_THEME) as Theme;
    return THEMES.some((x) => x.id === t) ? t : 'auto';
  });

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  const closeWelcome = () => {
    setWelcome(false);
    localStorage.setItem(LS_WELCOMED, '1');
  };

  const select = (t: Tab) => {
    setTab(t);
    localStorage.setItem(LS_TAB, t);
    closeWelcome();
  };

  const start = (t: Tab, example: ExampleTarget) => {
    select(t);
    runExample(example);
  };

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

  const reset = useArmedConfirm();

  const resetAll = async () => {
    await discardPending();
    localStorage.clear();
    await fetch('/api/store', { method: 'DELETE' }).catch(() => {});
    location.reload();
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span className="brand-text">Conduit</span>
        </span>
        <nav className="toptabs" role="tablist" aria-label="Protocol">
          {TABS.map((t, i) => (
            <span
              key={t.id}
              className={`toptab ${!welcome && tab === t.id ? 'active' : ''}`}
              role="tab"
              aria-selected={!welcome && tab === t.id}
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
        </nav>
        <div className="top-actions">
          <button
            type="button"
            className={`btn-ghost btn-sm ${welcome ? 'btn-on' : ''}`}
            title="What Conduit does and where to start"
            onClick={() => (welcome ? closeWelcome() : setWelcome(true))}
          >
            Start here
          </button>
          <button
            type="button"
            className={`btn-ghost btn-sm ${reset.showsArmed('all') ? 'btn-danger btn-on' : ''}`}
            title="Clear every saved connection, request and form in the app"
            onClick={() => (reset.isArmed('all') ? resetAll() : reset.arm('all'))}
            onMouseLeave={reset.disarm}
            onBlur={reset.disarm}
          >
            {reset.showsArmed('all') ? 'Click again to erase everything' : 'Reset data'}
          </button>
          <div className="seg seg-sm" role="group" aria-label="Theme">
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
        </div>
      </header>
      <StoreAlert />
      <main className="panel">
        {welcome && <Welcome onStart={start} onOpen={select} onClose={closeWelcome} />}
        {TABS.map((t) => (
          <div
            key={t.id}
            className="panel-slot"
            role="tabpanel"
            aria-label={t.label}
            hidden={welcome || tab !== t.id}
          >
            <t.Panel />
          </div>
        ))}
      </main>
    </div>
  );
}

const STARTS: { tab: Tab; example: ExampleTarget; icon: string; title: string; desc: string; sample: string }[] = [
  {
    tab: 'http',
    example: 'http',
    icon: 'H',
    title: 'Send an HTTP request',
    desc: 'A REST client with tabs, history, auth, cURL import and variables.',
    sample: 'GET https://httpbin.org/get?hello=conduit',
  },
  {
    tab: 'grpc',
    example: 'grpc',
    icon: 'G',
    title: 'Call gRPC with reflection',
    desc: 'No .proto files needed: Conduit asks the server which services it has.',
    sample: 'grpcb.in:9000  ->  addsvc.Add/Sum',
  },
  {
    tab: 'redis',
    example: 'redis',
    icon: 'R',
    title: 'Connect to Redis or a database',
    desc: 'Browse Redis keys by prefix, or query Postgres, MySQL, MongoDB and ClickHouse in DB.',
    sample: 'redis://127.0.0.1:6379  ·  list keys',
  },
  {
    tab: 'utils',
    example: 'utils',
    icon: 'U',
    title: 'Build a signing recipe',
    desc: 'Chain encode, hash, sign and encrypt steps, then reuse the result as a request variable.',
    sample: 'HMAC-SHA256 of a string, as hex',
  },
];

function Welcome({
  onStart,
  onOpen,
  onClose,
}: {
  onStart: (tab: Tab, example: ExampleTarget) => void;
  onOpen: (tab: Tab) => void;
  onClose: () => void;
}) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-kicker">Welcome to Conduit</div>
        <h1>Talk to any backend from one window.</h1>
        <p className="welcome-lead">
          Conduit is a local console for HTTP, gRPC, Redis, databases, Kafka, Pulsar and WebSockets. Pick a starting
          point below; each one opens with a working example filled in.
        </p>
        <div className="welcome-cards">
          {STARTS.map((s) => (
            <button type="button" key={s.title} className="welcome-card" onClick={() => onStart(s.tab, s.example)}>
              <div className="welcome-card-top">
                <span className="welcome-icon" aria-hidden>
                  {s.icon}
                </span>
                <span className="welcome-card-title">{s.title}</span>
                <span className="welcome-card-go">Try it →</span>
              </div>
              <div className="welcome-card-desc">{s.desc}</div>
              <code>{s.sample}</code>
            </button>
          ))}
        </div>
        <div className="welcome-tips">
          <div>
            <div className="welcome-tip-title">Tabs everywhere</div>
            <div className="welcome-tip">
              Each panel keeps several requests open. <kbd>{MOD}1</kbd> to <kbd>{MOD}0</kbd> switch panels.
            </div>
          </div>
          <div>
            <div className="welcome-tip-title">Variables</div>
            <div className="welcome-tip">
              Type <code>{'{{name}}'}</code> in any HTTP or gRPC field. Environments switch the values, e.g. dev and prod.
            </div>
          </div>
          <div>
            <div className="welcome-tip-title">Your data stays local</div>
            <div className="welcome-tip">Everything is saved to conduit-data.json on this machine. Reset data clears it.</div>
          </div>
        </div>
        <div className="welcome-foot">
          <span>Also here:</span>
          {(
            [
              ['db', 'DB'],
              ['ws', 'WebSocket / SSE'],
              ['kafka', 'Kafka'],
              ['pulsar', 'Pulsar'],
              ['webhook', 'Webhook capture'],
              ['diag', 'Network diagnostics'],
            ] as const
          ).map(([id, label]) => (
            <button type="button" key={id} className="btn-link" onClick={() => onOpen(id)}>
              {label}
            </button>
          ))}
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={onClose}>
            Skip, go to the app
          </button>
        </div>
      </div>
    </div>
  );
}

function StoreAlert() {
  const { failure, retry } = useStoreFailure();
  if (!failure) return null;
  return (
    <div className="store-alert" role="alert">
      <span>Settings are not being saved to disk, so changes would be lost on restart: {failure}</span>
      <button type="button" className="btn-secondary" onClick={retry}>
        Retry
      </button>
    </div>
  );
}
