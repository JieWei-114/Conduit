import { useEffect, useMemo, useState } from 'react';
import { Empty, Section } from './ui';
import { OutputView } from './OutputView';
import { SaveAs } from './SaveAs';
import { SecretField } from './SecretField';
import { useArmedConfirm } from './useArmedConfirm';
import { useFlash } from './useFlash';
import { VarList, withoutSecretValues } from './VarList';
import { provides, setSavedRecipes, useSavedRecipes, type SavedRecipe, type Var } from './vars';
import {
  groupOps,
  hasLiteral,
  isVisible,
  loadCatalog,
  newStep,
  referencedNames,
  runRecipes,
  type OpSpec,
  type ParamSpec,
  type RecipeResult,
  type Step,
  type StepResult,
} from './ops';

interface Draft {
  input: string;
  steps: Step[];
  vars: Var[];
}

const LS_DRAFT = 'conduit.ops.draft.v1';
const EMPTY: Draft = { input: '', steps: [], vars: [] };
/** Pause after the last edit before running, so typing does not send a request per key. */
const RUN_DELAY_MS = 350;

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

/** `draft` with an id on every step (recipes saved before ids existed have none). */
function withIds(draft: Draft): Draft {
  return { ...draft, steps: draft.steps.map((s) => (s.id ? s : { ...s, id: crypto.randomUUID() })) };
}

/**
 * `draft` without literal secret values: what the editor keeps between sessions on its own.
 * Secrets are kept only in a recipe the user saves by name.
 */
function withoutSecrets(draft: Draft, ops: OpSpec[]): Draft {
  return {
    input: draft.input,
    vars: withoutSecretValues(draft.vars),
    steps: draft.steps.map((s) => {
      const spec = ops.find((o) => o.id === s.op);
      const params = Object.fromEntries(
        Object.entries(s.params).map(([k, v]) => {
          const secret = spec?.params.find((p) => p.name === k)?.secret;
          return [k, secret && hasLiteral(v) ? '' : v];
        }),
      );
      return { ...s, params };
    }),
  };
}

const SAMPLE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

interface Starter {
  id: string;
  label: string;
  input: string;
  vars?: Var[];
  steps: [string, Record<string, string>][];
}

const STARTERS: Starter[] = [
  { id: 'base64', label: 'Base64 encode', input: 'hello, conduit', steps: [['base64.encode', {}]] },
  {
    id: 'hmac',
    label: 'HMAC-SHA256 signature',
    input: '{{body}}',
    vars: [
      { name: 'body', value: '{"amount":100}', secret: false },
      { name: 'secret', value: 'my-signing-key', secret: true },
    ],
    steps: [
      ['hmac', { alg: 'sha256', key: '{{secret}}', key_encoding: 'utf8' }],
      ['hex.encode', { case: 'lower' }],
    ],
  },
  {
    id: 'jwt',
    label: 'Decode a JWT',
    input: SAMPLE_JWT,
    steps: [
      ['jwt.decode', {}],
      ['json.get', { path: 'payload.name' }],
    ],
  },
  {
    id: 'aes',
    label: 'AES-GCM encrypt',
    input: 'hello, conduit',
    vars: [{ name: 'key', value: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', secret: true }],
    steps: [
      ['aes.encrypt', { mode: 'gcm', key: '{{key}}', key_encoding: 'hex', iv: '000102030405060708090a0b', iv_encoding: 'hex' }],
      ['base64.encode', {}],
    ],
  },
  { id: 'timestamp', label: 'Timestamp in ms', input: '', steps: [['now', { format: 'unix_ms' }]] },
];

function fromStarter(st: Starter, ops: OpSpec[]): Draft {
  return {
    input: st.input,
    vars: (st.vars ?? []).map((v) => ({ ...v })),
    steps: st.steps.flatMap(([op, params]) => {
      const spec = ops.find((o) => o.id === op);
      if (!spec) return [];
      const step = newStep(spec);
      return [{ ...step, params: { ...step.params, ...params } }];
    }),
  };
}

export default function RecipeEditor({ starter }: { starter?: { id: string; n: number } | null }) {
  const [ops, setOps] = useState<OpSpec[] | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [draft, setDraft] = useState<Draft>(() => withIds({ ...EMPTY, ...load<Partial<Draft>>(LS_DRAFT, {}) }));
  const saved = useSavedRecipes();
  const [picked, setPicked] = useState('');
  const [result, setResult] = useState<RecipeResult | null>(null);
  // the step ids the result was computed for, so a reordered card never shows another's output
  const [resultIds, setResultIds] = useState<string[]>([]);
  // a name the user was told already exists; saving it again replaces that recipe
  const [replacing, setReplacing] = useState('');
  const [runError, setRunError] = useState('');
  const [running, setRunning] = useState(false);
  const [rerun, setRerun] = useState(0);
  const [message, flash] = useFlash();
  const del = useArmedConfirm();

  const [catalogTry, setCatalogTry] = useState(0);
  useEffect(() => {
    setCatalogError('');
    loadCatalog().then(setOps, (e) => setCatalogError(String(e?.message ?? e)));
  }, [catalogTry]);

  // keep the draft across sessions, minus literal secrets
  useEffect(() => {
    if (ops) localStorage.setItem(LS_DRAFT, JSON.stringify(withoutSecrets(draft, ops)));
  }, [draft, ops]);

  // run after each edit, cancelling a run still in flight
  useEffect(() => {
    if (!ops || draft.steps.length === 0) {
      setResult(null);
      setRunError('');
      setRunning(false);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setRunning(true);
      try {
        // a secret left blank is not a value: {{name}} then says it is unknown instead of using ''
        const vars = Object.fromEntries(draft.vars.filter(provides).map((v) => [v.name.trim(), v.value]));
        const ids = draft.steps.map((s) => s.id ?? '');
        const r = await runRecipes(vars, [{ input: draft.input, steps: draft.steps }], abort.signal);
        setResult(r.results?.[0] ?? null);
        setResultIds(ids);
        setRunError(r.error ?? '');
      } catch (e: any) {
        if (e?.name !== 'AbortError') setRunError(String(e?.message ?? e));
      } finally {
        if (!abort.signal.aborted) setRunning(false);
      }
    }, RUN_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [draft, ops, rerun]);

  const [askStarter, setAskStarter] = useState('');
  const startArm = useArmedConfirm();
  const draftEmpty = draft.steps.length === 0 && !draft.input.trim() && draft.vars.length === 0;
  const applyStarter = (id: string) => {
    const st = STARTERS.find((x) => x.id === id);
    if (!st || !ops) return;
    setAskStarter('');
    startArm.disarm();
    setPicked('');
    setDraft(fromStarter(st, ops));
    flash(`Loaded "${st.label}". Edit any step, or save it under a name.`);
  };
  const clickStarter = (id: string) => {
    if (draftEmpty || startArm.isArmed(id)) applyStarter(id);
    else startArm.arm(id);
  };
  useEffect(() => {
    if (!starter || !ops) return;
    if (draftEmpty) applyStarter(starter.id);
    else setAskStarter(starter.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starter?.n, !!ops]);
  const asked = STARTERS.find((x) => x.id === askStarter);

  const specOf = (id: string) => ops?.find((o) => o.id === id);
  const update = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));
  const setStep = (i: number, step: Step) =>
    update({ steps: draft.steps.map((s, j) => (j === i ? step : s)) });
  const moveStep = (i: number, by: number) => {
    const steps = [...draft.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + by, 0, s);
    update({ steps });
  };

  // names referenced in the input or any parameter that no variable defines
  const missing = useMemo(() => {
    const defined = new Set(draft.vars.map((v) => v.name.trim()));
    const texts = [draft.input, ...draft.steps.flatMap((s) => Object.values(s.params))];
    return [...new Set(texts.flatMap(referencedNames))].filter((n) => !defined.has(n));
  }, [draft]);

  const persistSaved = (next: SavedRecipe[]) => setSavedRecipes(next);

  const openSaved = (name: string) => {
    setPicked(name);
    const s = saved.find((x) => x.name === name);
    if (s) setDraft(withIds({ ...EMPTY, ...s.draft }));
  };

  if (catalogError)
    return (
      <>
        <div className="status bad">Could not load the operations: {catalogError}</div>
        <div className="inline mt-2">
          <button className="btn-secondary" onClick={() => setCatalogTry((n) => n + 1)}>
            Retry
          </button>
          <span className="hint">The operations come from Conduit's own server; check that it is running.</span>
        </div>
      </>
    );
  if (!ops) return <div className="hint">Loading operations…</div>;

  return (
    <div className="recipe">
      <div className="saved-bar">
        <select
          className="saved-select"
          aria-label="Saved recipes"
          value={picked}
          onChange={(e) => openSaved(e.target.value)}
        >
          <option value="">{saved.length ? 'Open a saved recipe…' : 'No saved recipes yet'}</option>
          {saved.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <SaveAs
          suggested={picked}
          canSave={() => (draft.steps.length ? null : 'Add a step before saving')}
          onSave={(name) => {
            if (name !== picked && name !== replacing && saved.some((s) => s.name === name)) {
              setReplacing(name);
              return { keepOpen: `"${name}" already exists. Press Save again to replace it.` };
            }
            persistSaved([...saved.filter((s) => s.name !== name), { name, draft }]);
            setPicked(name);
            setReplacing('');
            return `Saved "${name}", secrets included`;
          }}
          onMessage={flash}
        />
        {picked && (
          <button
            className="btn-secondary btn-danger"
            onClick={() => {
              if (!del.isArmed(picked)) return del.arm(picked);
              persistSaved(saved.filter((s) => s.name !== picked));
              setPicked('');
              flash(`Deleted "${picked}"`);
            }}
            onMouseLeave={del.disarm}
            onBlur={del.disarm}
          >
            {del.showsArmed(picked) ? 'Click again to delete' : 'Delete'}
          </button>
        )}
        <span className="spacer" />
        <button
          className="btn-ghost"
          title="Start an empty recipe"
          onClick={() => {
            setPicked('');
            setDraft(EMPTY);
          }}
        >
          New
        </button>
      </div>
      <div className="hint">Saved recipes keep their secrets in conduit-data.json; the working draft does not.</div>
      {message && <div className="toast">{message}</div>}
      {asked && (
        <div className="inline mt-2">
          <span className="hint m-0">Replace the current draft with the "{asked.label}" template?</span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => (startArm.isArmed(`ask:${asked.id}`) ? applyStarter(asked.id) : startArm.arm(`ask:${asked.id}`))}
            onMouseLeave={startArm.disarm}
            onBlur={startArm.disarm}
          >
            {startArm.showsArmed(`ask:${asked.id}`) ? 'Click again to replace' : 'Replace draft'}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setAskStarter('')}>
            Keep draft
          </button>
        </div>
      )}

      <Section
        title={
          <>
            Variables <span className="count">({draft.vars.length})</span>
          </>
        }
        hint={<>Values you can use anywhere below as <code>{'{{name}}'}</code>. Mark keys and passwords as secret.</>}
      >
        <VarList vars={draft.vars} missing={missing} onChange={(vars) => update({ vars })} />
      </Section>

      <label htmlFor="recipe-input">Input</label>
      <textarea
        id="recipe-input"
        rows={3}
        value={draft.input}
        spellCheck={false}
        placeholder="Text for the first step, e.g. hello or {{body}}"
        onChange={(e) => update({ input: e.target.value })}
      />

      <label>
        Steps <span className="count">({draft.steps.length})</span>
        {running && <span className="run-dot" aria-label="running" />}
      </label>
      {draft.steps.length === 0 ? (
        <Empty
          icon="⛓"
          title="No steps yet"
          hint="Pick a step from the menu below, or start from a template. Each step takes the previous step's output."
        >
          {STARTERS.map((st) => (
            <button
              key={st.id}
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => clickStarter(st.id)}
              onMouseLeave={startArm.disarm}
              onBlur={startArm.disarm}
            >
              {startArm.showsArmed(st.id) ? 'Click again to replace the draft' : st.label}
            </button>
          ))}
        </Empty>
      ) : (
        <ol className="steps">
          {draft.steps.map((s, i) => {
            const spec = specOf(s.op);
            return spec ? (
              <StepCard
                key={s.id ?? i}
                index={i}
                count={draft.steps.length}
                step={s}
                spec={spec}
                result={stepResult(result, resultIds, s.id)}
                blockedBy={blockedBy(result, resultIds, s.id)}
                onChange={(next) => setStep(i, next)}
                onMove={(by) => moveStep(i, by)}
                onRemove={() => update({ steps: draft.steps.filter((_, j) => j !== i) })}
                onCopied={flash}
              />
            ) : (
              <li key={s.id ?? i} className="step step-bad">
                Unknown operation <code className="mono">{s.op}</code>
                <button className="btn-ghost" onClick={() => update({ steps: draft.steps.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <AddStep ops={ops} onAdd={(spec) => update({ steps: [...draft.steps, newStep(spec)] })} />

      {draft.steps.length > 0 && (
        <Section
          title="Output"
          actions={
            <button className="btn-ghost btn-sm" title="Run again: generators produce new values" onClick={() => setRerun((n) => n + 1)}>
              Run again
            </button>
          }
        >
          {runError && <div className="status bad">{runError}</div>}
          {result && !result.ok && <div className="status bad">{result.error}</div>}
          {result?.ok && result.output && <OutputView value={result.output} onCopied={flash} />}
          <div className="recipe-tip">
            <b>Use it in a request:</b> save this recipe, then in HTTP or gRPC open Variables → Advanced → Computed and pick
            it. Its output fills <code>{'{{name}}'}</code> before every send.
          </div>
        </Section>
      )}
    </div>
  );
}

/** The number of the failed step that kept step `i` from running, if one did. */
/** The result of step `id` in `result`, computed for the steps `ids` in that order. */
function stepResult(result: RecipeResult | null, ids: string[], id: string | undefined): StepResult | undefined {
  const at = id ? ids.indexOf(id) : -1;
  return at >= 0 ? result?.steps[at] : undefined;
}

/** The number of the failed step that kept step `id` from running, if one did. */
function blockedBy(result: RecipeResult | null, ids: string[], id: string | undefined): number | undefined {
  const at = id ? ids.indexOf(id) : -1;
  if (!result || result.ok || at < 0 || result.steps[at]) return undefined;
  const failed = result.steps.findIndex((s) => !s.ok);
  return failed >= 0 && failed < at ? failed + 1 : undefined;
}

/** A picker of every operation, grouped; choosing one appends it. */
function AddStep({ ops, onAdd }: { ops: OpSpec[]; onAdd: (spec: OpSpec) => void }) {
  return (
    <select
      className="add-step mt-3"
      aria-label="add a step"
      value=""
      onChange={(e) => {
        const spec = ops.find((o) => o.id === e.target.value);
        if (spec) onAdd(spec);
      }}
    >
      <option value="">+ Add a step…</option>
      {groupOps(ops).map(([group, list]) => (
        <optgroup key={group} label={group}>
          {list.map((o) => (
            <option key={o.id} value={o.id} title={o.description}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function StepCard({
  index,
  count,
  step,
  spec,
  result,
  blockedBy,
  onChange,
  onMove,
  onRemove,
  onCopied,
}: {
  index: number;
  count: number;
  step: Step;
  spec: OpSpec;
  result?: StepResult;
  /** Set when an earlier step failed, so this one did not run. */
  blockedBy?: number;
  onChange: (next: Step) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
  onCopied: (message: string) => void;
}) {
  const value = (p: ParamSpec) => step.params[p.name] ?? p.default;
  const setParam = (name: string, v: string) => onChange({ ...step, params: { ...step.params, [name]: v } });
  const visible = spec.params.filter((p) => isVisible(p, step.params, spec));
  const state = step.disabled ? 'off' : result ? (result.ok ? 'ok' : 'bad') : 'idle';

  return (
    <li className={`step step-${state}`}>
      <div className="step-head">
        <span className="step-idx">{index + 1}</span>
        <div className="step-title">
          <span className="step-name">{spec.label}</span>
          <span className="step-group">{spec.group}</span>
        </div>
        <div className="step-actions">
          <button
            type="button"
            role="switch"
            className={`switch ${step.disabled ? '' : 'on'}`}
            aria-checked={!step.disabled}
            aria-label={step.disabled ? 'Step is off' : 'Step is on'}
            title={step.disabled ? 'Turn this step back on' : 'Skip this step; its input passes through'}
            onClick={() => onChange({ ...step, disabled: !step.disabled })}
          >
            <span className="switch-knob" />
          </button>
          <span className="step-actions-sep" />
          <button type="button" className="btn-ghost btn-sm btn-icon" aria-label="move up" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button type="button" className="btn-ghost btn-sm btn-icon" aria-label="move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            ↓
          </button>
          <button type="button" className="btn-ghost btn-sm btn-icon btn-danger" aria-label="remove step" onClick={onRemove}>
            ✕
          </button>
        </div>
      </div>
      <div className="step-desc">{spec.description}</div>
      {!spec.uses_input && index > 0 && (
        <div className="step-desc text-warn">Starts fresh: the previous step's output is not used.</div>
      )}

      {visible.length > 0 && (
        <div className="step-params">
          {visible.map((p) => (
            <div key={p.name} className={p.kind === 'textarea' ? 'param-wide' : undefined}>
              <label>{p.label}</label>
              <ParamInput param={p} value={value(p)} onChange={(v) => setParam(p.name, v)} />
            </div>
          ))}
        </div>
      )}

      {!step.disabled && result?.error && <div className="status bad mt-2">{result.error}</div>}
      {!step.disabled && blockedBy && <div className="step-blocked">Not run: step {blockedBy} failed.</div>}
      {!step.disabled && result?.ok && result.output && (
        <div className="step-output">
          <OutputView value={result.output} onCopied={onCopied} />
        </div>
      )}
    </li>
  );
}

function ParamInput({ param, value, onChange }: { param: ParamSpec; value: string; onChange: (v: string) => void }) {
  switch (param.kind) {
    case 'select':
      return (
        <select value={value} aria-label={param.label} onChange={(e) => onChange(e.target.value)}>
          {param.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'bool':
      return (
        <div className="seg" role="group" aria-label={param.label}>
          {['true', 'false'].map((v) => (
            <button type="button" key={v} className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => onChange(v)}>
              {v === 'true' ? 'yes' : 'no'}
            </button>
          ))}
        </div>
      );
    case 'number':
      return (
        <input type="number" value={value} aria-label={param.label} placeholder={param.placeholder} onChange={(e) => onChange(e.target.value)} />
      );
    default:
      return (
        <SecretField
          value={value}
          secret={param.secret}
          multiline={param.kind === 'textarea'}
          placeholder={param.placeholder}
          ariaLabel={param.label}
          onChange={onChange}
        />
      );
  }
}
