import type { KeyboardEvent } from 'react';

/**
 * Keyboard support for long clickable row lists (history entries, key/topic
 * listings). The list is a single tab stop: only the row carrying tabIndex 0 is
 * reachable by Tab, Up/Down move focus between rows, Enter/Space activates.
 * Without this a 200-row listing would put 200 tab stops in front of whatever
 * control comes next.
 *
 * Pair with `rowTabIndex(i)` and `role="button"` on each row.
 */
export function rowKeyDown(activate: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const el = e.currentTarget;
    const next = (e.key === 'ArrowDown' ? el.nextElementSibling : el.previousElementSibling) as
      | HTMLElement
      | null;
    if (!next || !next.hasAttribute('tabindex')) return;
    el.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  };
}

/** Only the first row of a list starts reachable by Tab. */
export function rowTabIndex(i: number): number {
  return i === 0 ? 0 : -1;
}
