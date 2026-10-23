import { useState } from 'react';
import type { Shown } from './ops';

type View = 'text' | 'hex' | 'base64';

/**
 * One operation output, switchable between text, hex and Base64, with copy. Binary output
 * has no text form, so it opens on hex and the text view is not offered.
 */
export function OutputView({ value, onCopied }: { value: Shown; onCopied?: (what: string) => void }) {
  const hasText = value.text != null;
  const [view, setView] = useState<View>('text');
  const current: View = view === 'text' && !hasText ? 'hex' : view;
  const shown = current === 'text' ? value.text ?? '' : current === 'hex' ? value.hex : value.base64;

  const copy = () => {
    navigator.clipboard.writeText(shown).then(
      () => onCopied?.(`Copied ${current}`),
      () => onCopied?.('Copy failed: the clipboard is not available'),
    );
  };

  return (
    <div className="op-out">
      <div className="op-out-bar">
        <span className="op-out-label">Output</span>
        <div className="seg seg-sm" role="group" aria-label="Output format">
          {(['text', 'hex', 'base64'] as View[]).map((v) => (
            <button
              type="button"
              key={v}
              className={current === v ? 'on' : ''}
              aria-pressed={current === v}
              disabled={v === 'text' && !hasText}
              title={v === 'text' && !hasText ? 'binary output has no text form' : undefined}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="op-size">
          {value.size} byte{value.size === 1 ? '' : 's'}
          {!hasText && ' · binary'}
        </span>
        <button type="button" className="btn-ghost btn-sm" onClick={copy}>
          Copy
        </button>
      </div>
      <pre>{shown || <span className="faint">(empty)</span>}</pre>
    </div>
  );
}
