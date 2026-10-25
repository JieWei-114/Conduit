import { useMemo, useState } from 'react';
import { SaveAs } from './SaveAs';
import { useArmedConfirm } from './useArmedConfirm';
import { useDialog } from './useDialog';
import { LongField } from './ui';
import { VarList } from './VarList';
import { referencedNames } from './ops';
import {
  activeEnv,
  provides,
  setEnvs,
  useEnvs,
  useSavedRecipes,
  type Binding,
  type Extract,
  type RequestVars,
} from './vars';

/**
 * The variables section of a request form: which environment is active, the request's own
 * variables, values computed by saved recipes before each send, and values read from the
 * response into the environment afterwards.
 *
 * `texts` are the request's templates (URL, headers, body…), used to point out names that
 * nothing defines.
 */
export function RequestVarsBox({
  value,
  onChange,
  texts,
  onMessage,
}: {
  value: RequestVars;
  onChange: (next: RequestVars) => void;
  texts: string[];
  onMessage: (message: string) => void;
}) {
  const envs = useEnvs();
  const env = activeEnv(envs);
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(() => value.computed.length + value.extract.length > 0);
  const [editing, setEditing] = useState(false);
  const recipes = useSavedRecipes();

  const textsKey = texts.join('\u0000');
  const missing = useMemo(() => {
    const defined = new Set(
      [...(env?.vars ?? []), ...value.vars]
        .filter(provides)
        .map((v) => v.name.trim())
        .concat(value.computed.map((b) => b.name.trim())),
    );
    return [...new Set(textsKey.split('\u0000').flatMap(referencedNames))].filter((n) => !defined.has(n));
  }, [textsKey, env, value]);

  const set = (next: Partial<RequestVars>) => onChange({ ...value, ...next });
  const setBinding = (i: number, next: Partial<Binding>) =>
    set({ computed: value.computed.map((b, j) => (j === i ? { ...b, ...next } : b)) });
  const setExtract = (i: number, next: Partial<Extract>) =>
    set({ extract: value.extract.map((x, j) => (j === i ? { ...x, ...next } : x)) });
  const envCount = env?.vars.filter((v) => v.name.trim()).length ?? 0;
  const reqCount = value.vars.filter((v) => v.name.trim()).length;
  const advCount = value.computed.length + value.extract.length;

  const summary = [
    env ? (
      <span key="env">
        env <b>{env.name}</b>
        {envCount > 0 && ` (${envCount})`}
      </span>
    ) : (
      <span key="env">no environment</span>
    ),
    reqCount > 0 && <span key="req">{reqCount} request var{reqCount === 1 ? '' : 's'}</span>,
    value.computed.length > 0 && <span key="c">{value.computed.length} computed</span>,
    value.extract.length > 0 && <span key="x">{value.extract.length} extract</span>,
  ].filter(Boolean);

  return (
    <div className="vars-box">
      <div className="vars-head">
        <button type="button" className="vars-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className={`caret ${open ? 'open' : ''}`} aria-hidden>
            ▶
          </span>
          <span className="vars-title">Variables</span>
          <span className="vars-meta">
            {summary.map((x, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                {x}
              </span>
            ))}
            {missing.length > 0 && (
              <span className="vars-warn">
                {' · '}missing {missing.map((n) => `{{${n}}}`).join(', ')}
              </span>
            )}
          </span>
        </button>
        <select
          className="env-select"
          aria-label="Active environment"
          title="Active environment: its values fill {{name}} in this request"
          value={envs.active}
          onChange={(e) => setEnvs({ ...envs, active: e.target.value })}
        >
          <option value="">No environment</option>
          {envs.envs.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      {open && (
        <div className="vars-body">
          <div className="vars-example">
            Type <code>{'{{name}}'}</code> in the URL, headers, auth or body, e.g.{' '}
            <code>{'https://{{host}}/v1/users'}</code>. It is filled in just before the request is sent.
          </div>

          <div className="vars-sub">Environment</div>
          <div className="hint">
            Shared values for every HTTP and gRPC request. Switch environments to move between dev and prod.
          </div>
          <div className="inline">
            <span className="muted">
              {env ? (
                <>
                  <b>{env.name}</b> is active with {envCount} value{envCount === 1 ? '' : 's'}.
                </>
              ) : envs.envs.length ? (
                'None active. Pick one in the menu above.'
              ) : (
                'No environments yet.'
              )}
            </span>
            <span className="spacer" />
            <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(true)}>
              {envs.envs.length ? 'Manage environments' : 'Create an environment'}
            </button>
          </div>

          <div className="vars-sub">Request variables</div>
          <div className="hint">Only for this request. They win over an environment value with the same name.</div>
          <VarList vars={value.vars} missing={missing} onChange={(vars) => set({ vars })} />

          <button type="button" className="disclosure" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
            <span className={`caret ${advanced ? 'open' : ''}`} aria-hidden>
              ▶
            </span>
            Advanced: computed and extracted values
            {advCount > 0 && <span className="count">({advCount})</span>}
          </button>

          {advanced && (
            <>
              <div className="vars-sub">Computed</div>
              <div className="hint">
                Run a saved Recipe before each send, e.g. a timestamp or a signature, and use its output as{' '}
                <code>{'{{name}}'}</code>. Build recipes in Utils → Recipe.
              </div>
              <div className="kv">
                {value.computed.map((b, i) => (
                  <div className="kv-row computed" key={`${i}-${value.computed.length}`}>
                    <input
                      className="mono"
                      value={b.name}
                      placeholder="name"
                      spellCheck={false}
                      aria-label="Computed variable name"
                      onChange={(e) => setBinding(i, { name: e.target.value })}
                    />
                    <span className="arrow" aria-hidden>
                      =
                    </span>
                    <select aria-label="Recipe" value={b.recipe} onChange={(e) => setBinding(i, { recipe: e.target.value })}>
                      <option value="">Choose a saved recipe…</option>
                      {recipes.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.name}
                        </option>
                      ))}
                      {b.recipe && !recipes.some((r) => r.name === b.recipe) && (
                        <option value={b.recipe}>{b.recipe} (missing)</option>
                      )}
                    </select>
                    <button
                      type="button"
                      className={`btn-secondary btn-sm ${b.secret ? 'btn-on' : ''}`}
                      aria-pressed={b.secret}
                      title="Mask this value wherever the sent request is shown"
                      onClick={() => setBinding(i, { secret: !b.secret })}
                    >
                      secret
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-danger"
                      aria-label={`Remove ${b.name || 'computed variable'}`}
                      onClick={() => set({ computed: value.computed.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="chips">
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    if (!recipes.length) onMessage('Save a recipe in Utils → Recipe first, then choose it here');
                    set({ computed: [...value.computed, { name: '', recipe: recipes[0]?.name ?? '', secret: false }] });
                  }}
                >
                  + Computed value
                </button>
              </div>

              <div className="vars-sub">Extract from the response</div>
              <div className="hint">
                Save a value from a successful response into the environment, e.g. <code>data.token</code> →{' '}
                <code>{'{{token}}'}</code>, so the next request can use it.
                {!env && ' Choose an environment first: extracted values are saved into it.'}
              </div>
              <div className="kv">
                {value.extract.map((x, i) => (
                  <div className="kv-row extract" key={`${i}-${value.extract.length}`}>
                    <input
                      className="mono"
                      value={x.name}
                      placeholder="name"
                      spellCheck={false}
                      aria-label="Extracted variable name"
                      onChange={(e) => setExtract(i, { name: e.target.value })}
                    />
                    <span className="arrow" aria-hidden>
                      ←
                    </span>
                    <select
                      aria-label="Read from"
                      value={x.from}
                      onChange={(e) => setExtract(i, { from: e.target.value as Extract['from'] })}
                    >
                      <option value="json">JSON</option>
                      <option value="header">Header</option>
                    </select>
                    <LongField
                      className="mono"
                      value={x.path}
                      spellCheck={false}
                      placeholder={x.from === 'json' ? 'data.token' : 'x-request-id'}
                      aria-label={x.from === 'json' ? 'JSON path' : 'Header name'}
                      onChange={(path) => setExtract(i, { path })}
                    />
                    <button
                      type="button"
                      className={`btn-secondary btn-sm ${x.secret ? 'btn-on' : ''}`}
                      aria-pressed={!!x.secret}
                      title="Store it as a secret: masked, and kept out of history"
                      onClick={() => setExtract(i, { secret: !x.secret })}
                    >
                      secret
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon btn-danger"
                      aria-label={`Remove ${x.name || 'extract rule'}`}
                      onClick={() => set({ extract: value.extract.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="chips">
                <button
                  type="button"
                  className="chip"
                  onClick={() => set({ extract: [...value.extract, { name: '', from: 'json', path: '' }] })}
                >
                  + Extract rule
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {editing && <EnvDialog onClose={() => setEditing(false)} onMessage={onMessage} />}
    </div>
  );
}

/** Create, edit and delete environments. Changes apply at once, in every panel. */
function EnvDialog({ onClose, onMessage }: { onClose: () => void; onMessage: (m: string) => void }) {
  const envs = useEnvs();
  const ref = useDialog(true, onClose);
  const del = useArmedConfirm();
  const [selected, setSelected] = useState(envs.active || envs.envs[0]?.name || '');
  const env = envs.envs.find((e) => e.name === selected);

  return (
    <div className="modal" onClick={onClose}>
      <div
        className="modal-box env-dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Environments"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="out-title">Environments</span>
          <span className="spacer" />
          <button className="btn-ghost" onClick={onClose} title="Close (Esc)">
            Close
          </button>
        </div>
        <div className="hint m-0">
          Named sets of values, e.g. dev and prod, shared by HTTP and gRPC. Kept in conduit-data.json with their
          secrets.
        </div>

        <div className="inline mt-3">
          <div className="chips m-0">
            {envs.envs.map((e) => (
              <button
                type="button"
                key={e.name}
                className={`chip ${selected === e.name ? 'chip-active' : ''}`}
                aria-pressed={selected === e.name}
                onClick={() => setSelected(e.name)}
              >
                {e.name}
                {envs.active === e.name && ' · active'}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <SaveAs
            label="Add environment"
            placeholder="e.g. staging"
            onSave={(name) => {
              if (envs.envs.some((e) => e.name === name)) return { keepOpen: `"${name}" already exists — choose another name` };
              const base = env?.vars.map((v) => ({ ...v })) ?? [];
              setEnvs({ active: envs.active || name, envs: [...envs.envs, { name, vars: base }] });
              setSelected(name);
              return env ? `Added "${name}", copied from "${env.name}"` : `Added "${name}"`;
            }}
            onMessage={onMessage}
          />
        </div>

        {env ? (
          <>
            <div className="inline mt-3">
              <span className="vars-sub m-0">{env.name}</span>
              <span className="spacer" />
              {envs.active !== env.name && (
                <button className="btn-secondary" onClick={() => setEnvs({ ...envs, active: env.name })}>
                  Make active
                </button>
              )}
              <button
                className="btn-secondary btn-danger"
                onClick={() => {
                  if (!del.isArmed(env.name)) return del.arm(env.name);
                  const rest = envs.envs.filter((e) => e.name !== env.name);
                  setEnvs({ active: envs.active === env.name ? '' : envs.active, envs: rest });
                  setSelected(rest[0]?.name ?? '');
                  onMessage(`Deleted "${env.name}"`);
                }}
                onMouseLeave={del.disarm}
                onBlur={del.disarm}
              >
                {del.showsArmed(env.name) ? 'Click again to delete' : 'Delete'}
              </button>
            </div>
            <VarList
              vars={env.vars}
              onChange={(vars) =>
                setEnvs({ ...envs, envs: envs.envs.map((e) => (e.name === env.name ? { ...e, vars } : e)) })
              }
            />
          </>
        ) : (
          <div className="hint mt-3">No environments yet. Add one, e.g. staging, with the values that differ between environments.</div>
        )}
      </div>
    </div>
  );
}
