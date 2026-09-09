import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A transient one-line message, for telling the user what just happened —
 * or why it did not.
 *
 * Every panel needs this for the same reason: an action that quietly does
 * nothing is indistinguishable from a broken button, and a panel's connection
 * status line is the wrong place to say it because that line describes the
 * connection, not the last thing clicked.
 *
 * Render the returned message inside an element with the `toast` class.
 */
export function useFlash(holdMs = 1800): [string, (message: string) => void] {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const flash = useCallback(
    (next: string) => {
      setMessage(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(''), holdMs);
    },
    [holdMs],
  );

  // A message outliving its panel would fire setState after unmount.
  useEffect(() => () => clearTimeout(timer.current), []);

  return [message, flash];
}
