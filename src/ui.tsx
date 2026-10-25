import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

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

function tabTitle(label: string, title?: string): string {
  const t = title?.trim();
  return !t || t === label ? label : `${label}\n${t}`;
}

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
            title={tabTitle(label(t), title?.(t))}
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

const LONG_MAX_LINES = 6;

function fitHeight(el: HTMLTextAreaElement) {
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || 18;
  const chrome =
    parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  el.style.height = '0px';
  const full = el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const max = line * LONG_MAX_LINES + chrome;
  el.style.height = `${Math.ceil(Math.min(full, max))}px`;
  el.style.overflowY = full > max + 1 ? 'auto' : 'hidden';
}

export function LongField({
  value,
  onChange,
  onEnter,
  onKeyDown,
  onBlur,
  url = false,
  suggestions,
  className,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows'> & {
  value: string;
  onChange?: (next: string) => void;
  onEnter?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  url?: boolean;
  suggestions?: string[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const clean = (s: string) => (url ? s.replace(/\s*[\r\n]+\s*/g, '') : s.replace(/\r\n?|\n/g, ' '));
  const q = value.trim().toLowerCase();
  const matches =
    open && suggestions
      ? suggestions.filter((o) => o !== value && o.toLowerCase().includes(q)).slice(0, 50)
      : [];

  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current);
  }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pick = (o: string) => {
    onChange?.(o);
    setOpen(false);
    setHi(-1);
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (suggestions) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) return setOpen(true);
        const n = matches.length;
        if (n) setHi((h) => (e.key === 'ArrowDown' ? (h + 1) % n : (h - 1 + n) % n));
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === 'Enter' && matches[hi] !== undefined) {
        e.preventDefault();
        pick(matches[hi]);
        return;
      }
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onEnter?.(e);
  };

  const paste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const cleaned = clean(text.replace(/^\s+|\s+$/g, ''));
    if (!document.execCommand('insertText', false, cleaned)) {
      const el = e.currentTarget;
      const next = el.value.slice(0, el.selectionStart) + cleaned + el.value.slice(el.selectionEnd);
      onChange?.(next);
    }
  };

  const field = (
    <textarea
      ref={ref}
      rows={1}
      className={`long ${suggestions ? '' : className ?? ''}`}
      value={value}
      onChange={(e) => {
        onChange?.(clean(e.target.value));
        if (suggestions) {
          setOpen(true);
          setHi(-1);
        }
      }}
      onKeyDown={keyDown}
      onPaste={paste}
      onBlur={(e) => {
        setOpen(false);
        onBlur?.(e);
      }}
      role={suggestions ? 'combobox' : undefined}
      aria-expanded={suggestions ? matches.length > 0 : undefined}
      aria-autocomplete={suggestions ? 'list' : undefined}
      {...rest}
    />
  );
  if (!suggestions) return field;
  return (
    <div className={`long-combo ${className ?? ''}`}>
      {field}
      {matches.length > 0 && (
        <ul className="long-options" role="listbox">
          {matches.map((o, i) => (
            <li
              key={o}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'on' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ConnPill({ state, text }: { state: 'idle' | 'connecting' | 'live' | 'error'; text: string }) {
  const cls = state === 'live' ? 'ok live' : state === 'error' ? 'bad' : state === 'connecting' ? 'warn live' : '';
  return (
    <span className={`pill ${cls}`} aria-live="polite" title={text}>
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
