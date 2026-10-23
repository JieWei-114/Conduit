import { useState } from 'react';
import { hasLiteral } from './ops';

/**
 * A text field for a value that may be secret. While `secret` is set and the value holds a
 * literal (not just `{{variable}}` references), it is masked until the eye is pressed, so a
 * screenshot or a shared screen does not carry it. A value that only names variables stays
 * readable: masking `{{key}}` would hide nothing and only get in the way.
 */
export function SecretField({
  value,
  onChange,
  secret,
  multiline = false,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  secret: boolean;
  multiline?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const masked = secret && !revealed && hasLiteral(value);
  const toggle = secret && hasLiteral(value) && (
    <button
      type="button"
      className="eye"
      aria-pressed={revealed}
      aria-label={revealed ? 'hide value' : 'show value'}
      title={revealed ? 'Hide' : 'Show'}
      onClick={() => setRevealed((r) => !r)}
    >
      {revealed ? 'hide' : 'show'}
    </button>
  );

  return (
    <div className={`secret-wrap ${multiline ? 'secret-multi' : ''}`}>
      {multiline ? (
        <textarea
          rows={4}
          value={value}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={masked ? 'masked' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type={masked ? 'password' : 'text'}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {toggle}
    </div>
  );
}
