/**
 * Variables for requests: environments (shared by every panel), per-request variables,
 * values computed by saved recipes, and values extracted from a response. Substitution
 * itself happens in the backend (`/api/ops/render`), the same code the Utils recipes run.
 */
import { useSyncExternalStore } from 'react';
import { runRecipes, type Recipe, type Step } from './ops';

/** A `{{name}}` value. A secret one is masked on screen and kept out of history. */
export interface Var {
  name: string;
  value: string;
  secret: boolean;
}

export interface Env {
  name: string;
  vars: Var[];
}

/** A variable computed by a saved recipe before each send. */
export interface Binding {
  name: string;
  /** Name of a recipe saved in Utils → Recipe. */
  recipe: string;
  secret: boolean;
}

/** A value read from a successful response into the environment the request was sent with. */
export interface Extract {
  name: string;
  from: 'json' | 'header';
  /** JSON path (`data.token`) or header name. */
  path: string;
  /** Store it as a secret (masked, kept out of history). */
  secret?: boolean;
}

/** The variable settings one request carries. */
export interface RequestVars {
  vars: Var[];
  computed: Binding[];
  extract: Extract[];
}

export const NO_REQUEST_VARS: RequestVars = { vars: [], computed: [], extract: [] };

// ── environments: one store for every panel ───────────────────────────────────

const LS_ENVS = 'conduit.envs.v1';

interface EnvState {
  active: string;
  envs: Env[];
}

function readEnvs(): EnvState {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_ENVS) ?? 'null');
    if (raw && Array.isArray(raw.envs)) return { active: raw.active ?? '', envs: raw.envs };
  } catch {
    /* corrupt or absent: start empty */
  }
  return { active: '', envs: [] };
}

let envState: EnvState | null = null;
const listeners = new Set<() => void>();

function current(): EnvState {
  envState ??= readEnvs();
  return envState;
}

/**
 * Replace the environment state. Environments are things the user creates and names, so
 * they are kept with their secrets, like any other saved item.
 */
export function setEnvs(next: EnvState) {
  envState = next;
  localStorage.setItem(LS_ENVS, JSON.stringify(next));
  listeners.forEach((l) => l());
}

/** The environments and the active one, re-rendering on any change from any panel. */
export function useEnvs(): EnvState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
  );
}

export function activeEnv(state: EnvState): Env | undefined {
  return state.envs.find((e) => e.name === state.active);
}

/**
 * Set `values` in the environment named `envName`. A new variable is secret when `secret`
 * names it; an existing one keeps its own flag. Throws when there is no such environment.
 */
export function writeToEnv(envName: string, values: Record<string, string>, secret: Set<string>): void {
  const state = current();
  if (!state.envs.some((e) => e.name === envName))
    throw new Error(
      envName
        ? `environment "${envName}" no longer exists`
        : 'choose an environment to save extracted values into (Variables → environments)',
    );
  const envs = state.envs.map((e) => {
    if (e.name !== envName) return e;
    const vars = [...e.vars];
    for (const [name, value] of Object.entries(values)) {
      const i = vars.findIndex((v) => v.name === name);
      if (i >= 0) vars[i] = { ...vars[i], value, secret: vars[i].secret || secret.has(name) };
      else vars.push({ name, value, secret: secret.has(name) });
    }
    return { ...e, vars };
  });
  setEnvs({ ...state, envs });
}

// ── saved recipes (from Utils) ────────────────────────────────────────────────

/** Where Utils → Recipe keeps the recipes saved by name. */
export const LS_RECIPES = 'conduit.ops.recipes.v1';

export interface SavedRecipe {
  name: string;
  draft: { input: string; steps: Step[]; vars: Var[] };
}

const recipeListeners = new Set<() => void>();
let recipeSnapshot: SavedRecipe[] | null = null;

/** Store the saved recipes and tell every panel that lists them. */
export function setSavedRecipes(next: SavedRecipe[]) {
  localStorage.setItem(LS_RECIPES, JSON.stringify(next));
  recipeSnapshot = null;
  recipeListeners.forEach((l) => l());
}

/** The saved recipes, re-rendering when Utils → Recipe saves or deletes one. */
export function useSavedRecipes(): SavedRecipe[] {
  return useSyncExternalStore(
    (l) => {
      recipeListeners.add(l);
      return () => recipeListeners.delete(l);
    },
    () => (recipeSnapshot ??= savedRecipes()),
  );
}

/** The saved recipes, each with every field present (older or hand-edited entries may lack some). */
export function savedRecipes(): SavedRecipe[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_RECIPES) ?? '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter((r) => r && typeof r.name === 'string')
      .map((r) => ({
        name: r.name,
        draft: {
          input: String(r.draft?.input ?? ''),
          steps: Array.isArray(r.draft?.steps) ? r.draft.steps : [],
          vars: Array.isArray(r.draft?.vars) ? r.draft.vars : [],
        },
      }));
  } catch {
    return [];
  }
}

// ── resolving a request ───────────────────────────────────────────────────────

export interface Resolved {
  /** The templates with every `{{name}}` filled in, by the caller's keys. */
  rendered: Record<string, string>;
  /** Values that are secret, for masking anything shown or kept after the send. */
  secrets: string[];
}

/**
 * Whether `v` provides a value. A secret left blank is not one: after a reload its value is
 * gone on purpose, and an empty string must not shadow the environment's value.
 */
export function provides(v: Var): boolean {
  return v.name.trim() !== '' && !(v.secret && v.value === '');
}

/** Variable values by name: environment, then the request's own, the request winning. */
function baseVars(env: Env | undefined, req: RequestVars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of [...(env?.vars ?? []), ...req.vars]) if (provides(v)) out[v.name.trim()] = v.value;
  return out;
}

/** The answer of a backend endpoint, or an error that says what went wrong in words. */
async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 413) throw new Error('the request is too large for Conduit to process (16 MB at most)');
  if (!res.ok) throw new Error(`Conduit's server answered HTTP ${res.status}`);
  return res.json();
}

/**
 * Run the request's computed variables, then fill `templates`. Throws with a message naming
 * the variable, recipe or template that failed; nothing should be sent then.
 */
export async function resolve(
  templates: Record<string, string>,
  req: RequestVars,
  env: Env | undefined,
): Promise<Resolved> {
  const saved = savedRecipes();
  const recipes: (Recipe & { defaults: Record<string, string> })[] = req.computed
    .filter((b) => b.name.trim())
    .map((b) => {
      if (!b.recipe) throw new Error(`computed \`${b.name}\`: choose the recipe that computes it`);
      const r = saved.find((s) => s.name === b.recipe);
      if (!r) throw new Error(`computed \`${b.name}\`: no saved recipe named "${b.recipe}" — save it in Utils → Recipe`);
      return {
        name: b.name.trim(),
        input: r.draft.input,
        steps: r.draft.steps,
        defaults: Object.fromEntries(r.draft.vars.filter(provides).map((v) => [v.name.trim(), v.value])),
      };
    });
  const r = await postJson('/api/ops/render', { vars: baseVars(env, req), recipes, templates });
  if (!r.ok) throw new Error(r.error ?? 'variables could not be resolved');
  const secretNames = new Set([
    ...[...(env?.vars ?? []), ...req.vars].filter((v) => v.secret).map((v) => v.name.trim()),
    ...req.computed.filter((b) => b.secret).map((b) => b.name.trim()),
  ]);
  const values = { ...baseVars(env, req), ...(r.computed as Record<string, string>) };
  const secrets = Object.entries(values)
    .filter(([name, value]) => secretNames.has(name) && value.length >= 4)
    .map(([, value]) => value);
  return { rendered: r.rendered, secrets };
}

/** Whether any of `texts` references a variable, so the render round trip can be skipped. */
export function usesVars(texts: string[], req: RequestVars): boolean {
  return req.computed.length > 0 || texts.some((t) => t.includes('{{'));
}

/** base64 of `s` as UTF-8, or '' when it cannot be encoded. */
function b64(s: string): string {
  try {
    return btoa(unescape(encodeURIComponent(s)));
  } catch {
    return '';
  }
}

/**
 * `text` with every secret value replaced by a mask, also in the forms a request commonly
 * carries it: URL-encoded and base64. Longest first, so a secret that contains another is
 * hidden whole. Values shorter than 4 characters are not masked: hiding every "1" would
 * garble the text and protect nothing.
 */
export function maskSecrets(text: string, secrets: string[]): string {
  const forms = new Set<string>();
  for (const s of secrets) for (const f of [s, encodeURIComponent(s), b64(s)]) if (f.length >= 4) forms.add(f);
  let out = text;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join('••••••');
  return out;
}

/**
 * Read `rules` out of a response into the environment `envName` (the one the request was sent
 * with). `jsonBody` is false when the body is not JSON (protobuf text), so a JSON rule can say
 * why it cannot apply. Throws naming the rule that found nothing.
 */
export async function extractInto(
  rules: Extract[],
  response: { body: string; headers: Record<string, string>; jsonBody: boolean },
  envName: string,
): Promise<{ env: string; names: string[] }> {
  const active = rules.filter((r) => r.name.trim() && r.path.trim());
  if (!active.length) return { env: envName, names: [] };
  const values: Record<string, string> = {};
  const fromJson = active.filter((r) => r.from === 'json');
  if (fromJson.length && !response.jsonBody)
    throw new Error(
      `extract \`${fromJson[0].name}\`: this response is protobuf text, not JSON — read the value from a header, or call the method through reflection`,
    );
  if (fromJson.length) {
    const run = await runRecipes(
      { response: response.body },
      fromJson.map((r) => ({
        name: r.name.trim(),
        input: '{{response}}',
        steps: [{ op: 'json.get', params: { path: r.path.trim() } }],
      })),
    );
    if (!run.results) throw new Error(`extract: ${run.error ?? 'the response could not be read'}`);
    for (const [i, res] of run.results.entries()) {
      if (!res.ok || res.output?.text == null)
        // the step's own message, without the engine's "step 1 (json.get):" prefix
        throw new Error(
          `extract \`${fromJson[i].name}\`: ${res.steps[0]?.error ?? res.error ?? 'the value is not text'}`,
        );
      values[fromJson[i].name.trim()] = res.output.text;
    }
  }
  for (const r of active.filter((x) => x.from === 'header')) {
    const key = Object.keys(response.headers).find((k) => k.toLowerCase() === r.path.trim().toLowerCase());
    if (key === undefined) throw new Error(`extract \`${r.name}\`: no response header "${r.path}"`);
    values[r.name.trim()] = response.headers[key];
  }
  writeToEnv(envName, values, new Set(active.filter((r) => r.secret).map((r) => r.name.trim())));
  return { env: envName, names: Object.keys(values) };
}
