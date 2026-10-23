/**
 * Client for the operation engine (`/api/ops`): the catalog of operations and running
 * recipes. Shared by the Utils recipe editor and request variables.
 */

export interface ParamSpec {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'select' | 'number' | 'bool';
  /** Masked in the UI and left out of anything saved automatically. */
  secret: boolean;
  options: string[];
  default: string;
  placeholder: string;
  /** Shown only when another parameter has one of these values. */
  when: [string, string[]] | null;
}

export interface OpSpec {
  id: string;
  group: string;
  label: string;
  description: string;
  uses_input: boolean;
  params: ParamSpec[];
}

export interface Step {
  /** UI identity, so a moved step keeps its own state; the engine ignores it. */
  id?: string;
  op: string;
  params: Record<string, string>;
  disabled?: boolean;
}

export interface Recipe {
  /** Set: the output becomes `{{name}}` for the recipes after it. */
  name?: string;
  /** The first step's input; may reference variables. */
  input: string;
  steps: Step[];
}

/** One output in the forms the UI can show. `text` is absent for binary data. */
export interface Shown {
  text?: string | null;
  hex: string;
  base64: string;
  size: number;
}

export interface StepResult {
  op: string;
  ok: boolean;
  skipped: boolean;
  error?: string;
  output?: Shown;
}

export interface RecipeResult {
  name: string;
  ok: boolean;
  error?: string;
  output?: Shown;
  steps: StepResult[];
}

export interface RunResponse {
  ok: boolean;
  results?: RecipeResult[];
  error?: string;
}

let catalog: Promise<OpSpec[]> | null = null;

/** The operation catalog, fetched once per session. A failed fetch is retried next call. */
export function loadCatalog(): Promise<OpSpec[]> {
  catalog ??= fetch('/api/ops/catalog')
    .then((r) => {
      if (!r.ok) throw new Error(`catalog: HTTP ${r.status}`);
      return r.json();
    })
    .then((d: { ops: OpSpec[] }) => d.ops)
    .catch((e) => {
      catalog = null;
      throw e;
    });
  return catalog;
}

/** Run `recipes` in order against `vars`; named recipes feed the ones after them. */
export async function runRecipes(
  vars: Record<string, string>,
  recipes: Recipe[],
  signal?: AbortSignal,
): Promise<RunResponse> {
  const r = await fetch('/api/ops/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vars, recipes }),
    signal,
  });
  if (r.status === 413) return { ok: false, error: 'the input is too large for Conduit to process (16 MB at most)' };
  if (!r.ok) return { ok: false, error: `Conduit's server answered HTTP ${r.status}` };
  return r.json();
}

/** Whether `param` applies given the step's other values (its `when` condition). */
export function isVisible(param: ParamSpec, values: Record<string, string>, spec: OpSpec): boolean {
  if (!param.when) return true;
  const [other, allowed] = param.when;
  const otherSpec = spec.params.find((p) => p.name === other);
  const current = values[other] ?? otherSpec?.default ?? '';
  return allowed.includes(current);
}

/** A step for `spec` with every parameter at its default. */
export function newStep(spec: OpSpec): Step {
  return {
    id: crypto.randomUUID(),
    op: spec.id,
    params: Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
  };
}

/** Whether `value` holds anything besides `{{variable}}` references — i.e. a literal secret. */
export function hasLiteral(value: string): boolean {
  return value.replace(/\{\{[^}]*\}\}/g, '').trim() !== '';
}

/** `{{name}}` references in `text`, each once, in order. */
export function referencedNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g))
    if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The catalog grouped for a picker, in catalog order. */
export function groupOps(ops: OpSpec[]): [string, OpSpec[]][] {
  const groups = new Map<string, OpSpec[]>();
  for (const o of ops) groups.set(o.group, [...(groups.get(o.group) ?? []), o]);
  return [...groups.entries()];
}
