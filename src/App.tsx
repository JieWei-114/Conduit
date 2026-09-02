import { useState } from 'react';
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

const TABS: { id: Tab; label: string }[] = [
  { id: 'http', label: 'HTTP' },
  { id: 'grpc', label: 'gRPC' },
  { id: 'db', label: 'DB' },
  { id: 'redis', label: 'Redis' },
  { id: 'ws', label: 'WS/SSE' },
  { id: 'pulsar', label: 'Pulsar' },
  { id: 'kafka', label: 'Kafka' },
  { id: 'webhook', label: 'Webhook' },
  { id: 'diag', label: 'Diag' },
  { id: 'utils', label: 'Utils' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = localStorage.getItem(LS_TAB) as Tab;
    return TABS.some((x) => x.id === t) ? t : 'http';
  });

  const select = (t: Tab) => {
    setTab(t);
    localStorage.setItem(LS_TAB, t);
  };

  const resetAll = async () => {
    if (!confirm('Clear ALL saved data (connections, history, forms)?')) return;
    localStorage.clear();
    await fetch('/api/store', { method: 'DELETE' }).catch(() => {});
    location.reload();
  };

  // panels stay mounted so live feeds / in-flight requests survive tab switches
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Conduit</span>
        {TABS.map((t) => (
          <span
            key={t.id}
            className={`toptab ${tab === t.id ? 'active' : ''}`}
            onClick={() => select(t.id)}
          >
            {t.label}
          </span>
        ))}
        <span className="toptab reset-all" title="Clear all saved data" onClick={resetAll}>
          reset data
        </span>
      </header>
      <main className="panel">
        <div style={{ display: tab === 'grpc' ? undefined : 'none', height: '100%' }}>
          <GrpcPanel />
        </div>
        <div style={{ display: tab === 'http' ? undefined : 'none', height: '100%' }}>
          <HttpPanel />
        </div>
        <div style={{ display: tab === 'redis' ? undefined : 'none', height: '100%' }}>
          <RedisPanel />
        </div>
        <div style={{ display: tab === 'db' ? undefined : 'none', height: '100%' }}>
          <DbPanel />
        </div>
        <div style={{ display: tab === 'ws' ? undefined : 'none', height: '100%' }}>
          <WsPanel />
        </div>
        <div style={{ display: tab === 'kafka' ? undefined : 'none', height: '100%' }}>
          <KafkaPanel />
        </div>
        <div style={{ display: tab === 'pulsar' ? undefined : 'none', height: '100%' }}>
          <PulsarPanel />
        </div>
        <div style={{ display: tab === 'webhook' ? undefined : 'none', height: '100%' }}>
          <WebhookPanel />
        </div>
        <div style={{ display: tab === 'diag' ? undefined : 'none', height: '100%' }}>
          <DiagPanel />
        </div>
        <div style={{ display: tab === 'utils' ? undefined : 'none', height: '100%' }}>
          <UtilsPanel />
        </div>
      </main>
    </div>
  );
}
