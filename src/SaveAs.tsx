import { useEffect, useRef, useState } from 'react';

/**
 * A save button that asks for a name in place.
 *
 * The row stays a single button until saving is actually wanted, so an
 * occasional action costs no permanent field, and the naming step still happens
 * inside the app rather than in a webview dialog.
 *
 * `canSave` runs before the name is asked for: being told the host is empty
 * after typing a name is worse than being told instead of being asked.
 */
export function SaveAs({
  label = 'Save',
  placeholder = 'Name to save as',
  suggested = '',
  canSave,
  onSave,
  onMessage,
}: {
  label?: string;
  placeholder?: string;
  /** Prefilled name, for re-saving something already named. */
  suggested?: string;
  /** Return a reason saving is not possible yet, or null when it is. */
  canSave?: () => string | null;
  /**
   * Commit the name. Return a confirmation to show, or void. Return `{ keepOpen }` to show a
   * message and leave the name field open, e.g. when the name is taken.
   */
  onSave: (name: string) => string | void | { keepOpen: string };
  /** Where to report the reason, the confirmation, and a missing name. */
  onMessage?: (message: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(suggested);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  const begin = () => {
    const reason = canSave?.();
    if (reason) return onMessage?.(reason);
    setName(suggested);
    setNaming(true);
  };

  const commit = () => {
    const trimmed = name.trim();
    if (!trimmed) return onMessage?.('Type a name to save it under');
    const confirmation = onSave(trimmed);
    if (typeof confirmation === 'object') return onMessage?.(confirmation.keepOpen);
    setNaming(false);
    setName('');
    if (confirmation) onMessage?.(confirmation);
  };

  const cancel = () => {
    setNaming(false);
    setName('');
  };

  if (!naming) {
    return (
      <button className="btn-secondary" onClick={begin} title="Save these settings under a name">
        {label}
      </button>
    );
  }

  return (
    <>
      <input
        ref={field}
        className="save-name"
        placeholder={placeholder}
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') cancel();
        }}
      />
      <button className="btn-primary" onClick={commit} title="Save under this name">
        {label}
      </button>
      <button className="btn-ghost" onClick={cancel} title="Cancel (Esc)">
        Cancel
      </button>
    </>
  );
}
