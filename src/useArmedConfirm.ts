import { useCallback, useEffect, useRef, useState } from 'react';

/** A confirming click this soon after arming is treated as a double-click. */
const MIN_ARM_MS = 600;

/** An armed control disarms itself after this long, so it cannot linger. */
const AUTO_DISARM_MS = 4000;

/**
 * Two-step confirmation for a destructive action, keyed so a list of rows can
 * each arm independently.
 *
 * The elapsed-time floor is the part that matters: a double-click lands 100-300ms
 * apart, so without it the second click of an accidental double-click confirms
 * the action. A "move the pointer away and back" rule would also stop that, but
 * only for a pointer — a keyboard user pressing Enter twice never leaves the
 * element, and this guards both.
 *
 * Usage:
 *   const { isArmed, arm, disarm } = useArmedConfirm();
 *   <button
 *     onClick={() => (isArmed(key) ? doIt() : arm(key))}
 *     onMouseLeave={disarm}
 *     onBlur={disarm}
 *   >{isArmed(key) ? 'Confirm delete' : 'Delete'}</button>
 */
export function useArmedConfirm() {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const armedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const disarm = useCallback(() => {
    clearTimeout(timer.current);
    setArmedKey(null);
  }, []);

  const arm = useCallback((key: string) => {
    armedAt.current = Date.now();
    setArmedKey(key);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmedKey(null), AUTO_DISARM_MS);
  }, []);

  /** Whether this key is armed *and* has been long enough to be deliberate. */
  const isArmed = useCallback(
    (key: string) => armedKey === key && Date.now() - armedAt.current >= MIN_ARM_MS,
    [armedKey],
  );

  /** Whether this key shows its armed label, regardless of the time floor. */
  const showsArmed = useCallback((key: string) => armedKey === key, [armedKey]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { isArmed, showsArmed, arm, disarm };
}
