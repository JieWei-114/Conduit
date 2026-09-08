import { useEffect, useRef } from 'react';

/** Elements that can hold focus inside a dialog, in document order. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes an open overlay behave like a dialog for someone not using a mouse.
 *
 * A backdrop click and a close button only serve a pointer. Without this, a
 * keyboard user who opens the overlay has no way to dismiss it, and Tab walks
 * out of it into the page behind — which is still rendered and still clickable,
 * so focus lands on controls the overlay is supposed to be covering.
 *
 * Returns a ref to attach to the dialog container.
 *
 * @param open  whether the dialog is currently rendered
 * @param close called on Escape
 */
export function useDialog(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  /* Whatever had focus when the dialog opened, so it can be handed back. Losing
     it would drop the caret to the top of the document on close. */
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement as HTMLElement | null;

    /* Focus the first control rather than the container: the container itself
       is not a control, so a screen reader would announce nothing actionable. */
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (items.length === 0) return;
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      // Wrap at the edge so Tab cycles inside the dialog instead of leaving it.
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreTo.current?.focus?.();
    };
  }, [open, close]);

  return ref;
}
