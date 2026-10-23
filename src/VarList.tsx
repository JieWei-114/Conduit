import { SecretField } from './SecretField';
import type { Var } from './vars';

/**
 * Edit a list of `{{name}}` variables: name, value, and whether the value is secret. Names
 * referenced somewhere but not defined (`missing`) are offered as chips that add them.
 */
export function VarList({
  vars,
  onChange,
  missing = [],
  addLabel = '+ Variable',
}: {
  vars: Var[];
  onChange: (vars: Var[]) => void;
  missing?: string[];
  addLabel?: string;
}) {
  const set = (i: number, next: Partial<Var>) =>
    onChange(vars.map((v, j) => (j === i ? { ...v, ...next } : v)));
  const problem = (v: Var, i: number): string => {
    const name = v.name.trim();
    if (!name) return '';
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return 'a name is letters, digits, _ - and . only, so {{…}} can refer to it';
    if (vars.findIndex((w) => w.name.trim() === name) !== i) return 'the same name appears above; the last one wins';
    if (v.secret && v.value === '') return 'enter the value: secrets are not kept between sessions unless saved';
    return '';
  };
  return (
    <>
      {vars.length > 0 && (
        <div className="kv">
          {vars.map((v, i) => (
            <div key={`${i}-${vars.length}`}>
              <div className="kv-row with-secret">
                <input
                  className="mono"
                  value={v.name}
                  spellCheck={false}
                  placeholder="name"
                  aria-label="Variable name"
                  onChange={(e) => set(i, { name: e.target.value })}
                />
                <SecretField
                  value={v.value}
                  secret={v.secret}
                  placeholder="value"
                  ariaLabel={`Value of ${v.name || 'variable'}`}
                  onChange={(value) => set(i, { value })}
                />
                <button
                  type="button"
                  className={`btn-secondary btn-sm ${v.secret ? 'btn-on' : ''}`}
                  aria-pressed={v.secret}
                  title="A secret is masked on screen and left out of history and auto-saved drafts"
                  onClick={() => set(i, { secret: !v.secret })}
                >
                  secret
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-icon btn-danger"
                  aria-label={`Remove ${v.name || 'variable'}`}
                  onClick={() => onChange(vars.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
              {problem(v, i) && <div className="hint text-warn var-problem">{problem(v, i)}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="chips">
        {missing.map((n) => (
          <button
            type="button"
            key={n}
            className="chip chip-warn chip-mono"
            title="Used but not defined. Click to add it."
            onClick={() => onChange([...vars, { name: n, value: '', secret: false }])}
          >
            + {`{{${n}}}`}
          </button>
        ))}
        <button
          type="button"
          className="chip"
          onClick={() => onChange([...vars, { name: '', value: '', secret: false }])}
        >
          {addLabel}
        </button>
      </div>
    </>
  );
}

/** `vars` with every secret value blanked: what may be kept without the user saving it. */
export function withoutSecretValues(vars: Var[]): Var[] {
  return vars.map((v) => (v.secret ? { ...v, value: '' } : v));
}
