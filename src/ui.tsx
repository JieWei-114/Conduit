import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

export function PanelHead({
  title,
  tagline,
  badge,
  actions,
}: {
  title: ReactNode;
  tagline?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="panel-head">
      <div className="panel-head-text">
        <h2 className="panel-title">
          {title}
          {badge && <span className="badge">{badge}</span>}
        </h2>
        {tagline && <div className="panel-tagline">{tagline}</div>}
      </div>
      {actions && <div className="panel-head-actions">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  hint,
  actions,
  flush,
  children,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`section ${flush ? 'section-flush' : ''} ${className ?? ''}`}>
      {(title || actions) && (
        <div className="section-head">
          {title && <h3 className="section-title">{title}</h3>}
          {actions && <div className="spacer inline">{actions}</div>}
        </div>
      )}
      {hint && <div className="hint">{hint}</div>}
      {children}
    </section>
  );
}

export function Empty({
  icon,
  title,
  hint,
  children,
  compact,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={`empty ${compact ? 'compact' : ''} ${className ?? ''}`}>
      {icon && <div className="empty-icon" aria-hidden>{icon}</div>}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}

type TabState = 'live' | 'connecting' | 'error' | 'busy' | undefined;

export function ReqTabs<T extends { id: number }>({
  tabs,
  activeId,
  ariaLabel,
  label,
  title,
  state,
  onSelect,
  onClose,
  onAdd,
  addTitle = 'New tab',
}: {
  tabs: T[];
  activeId: number;
  ariaLabel: string;
  label: (t: T) => string;
  title?: (t: T) => string;
  state?: (t: T) => TabState;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onAdd: () => void;
  addTitle?: string;
}) {
  return (
    <div className="req-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => {
        const s = state?.(t);
        return (
          <button
            type="button"
            key={t.id}
            className={`req-tab ${t.id === activeId ? 'active' : ''}`}
            role="tab"
            aria-selected={t.id === activeId}
            onClick={() => onSelect(t.id)}
            title={title?.(t)}
          >
            {s && <span className={`dot ${s === 'busy' ? 'connecting' : s}`} aria-label={s} />}
            <span className="req-tab-label">{label(t)}</span>
            {tabs.length > 1 && (
              <i
                className="chip-x"
                role="button"
                tabIndex={0}
                aria-label="Close tab"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose(t.id);
                  }
                }}
              >
                ✕
              </i>
            )}
          </button>
        );
      })}
      <button type="button" className="req-tab req-tab-add" aria-label={addTitle} title={addTitle} onClick={onAdd}>
        +
      </button>
    </div>
  );
}

export function ConnPill({ state, text }: { state: 'idle' | 'connecting' | 'live' | 'error'; text: string }) {
  const cls = state === 'live' ? 'ok live' : state === 'error' ? 'bad' : state === 'connecting' ? 'warn live' : '';
  return (
    <span className={`pill ${cls}`} aria-live="polite">
      {text}
    </span>
  );
}

export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; value: () => string }>();
const discardHooks = new Set<() => void | Promise<void>>();
let discarded = false;

export function flushPending() {
  if (discarded) return;
  for (const [key, p] of pending) {
    clearTimeout(p.timer);
    localStorage.setItem(key, p.value());
  }
  pending.clear();
}

export function isDiscarded() {
  return discarded;
}

export function onDiscard(fn: () => void | Promise<void>) {
  discardHooks.add(fn);
}

export function discardPending() {
  discarded = true;
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  return Promise.all([...discardHooks].map((fn) => fn())).then(() => undefined);
}

export function persistLater(key: string, value: () => string, delay = 300) {
  if (discarded) return;
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    pending.delete(key);
    localStorage.setItem(key, value());
  }, delay);
  pending.set(key, { timer, value });
}

export function usePersist(key: string, value: unknown, serialize: () => string, delay = 300) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    persistLater(key, serialize, delay);
  }, [value]);
}

export function tryJson(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

function timeOf(at?: string): string {
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString();
}

export const FeedRow = memo(function FeedRow({
  channel,
  at,
  text,
  meta,
  tone,
  copy,
  pretty = true,
}: {
  channel: ReactNode;
  at?: string;
  text: string;
  meta?: string;
  tone?: string;
  copy?: boolean;
  pretty?: boolean;
}) {
  const shown = pretty ? tryJson(text) ?? text : text;
  return (
    <div className={`feed-item ${tone ?? ''}`}>
      <div className="feed-top">
        <span className="feed-ch">{channel}</span>
        <span className="feed-time">{timeOf(at)}</span>
      </div>
      {meta && <div className="feed-props">{meta}</div>}
      {text && <div className="feed-msg">{shown}</div>}
      {copy && text && (
        <div className="feed-actions">
          <button type="button" className="btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(text)}>
            Copy
          </button>
        </div>
      )}
    </div>
  );
});
