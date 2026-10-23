//! The operation engine behind Utils recipes and request variables. A recipe is a list of
//! steps; each step is one operation from the catalog. Recipes run in order and each named
//! recipe's output becomes a variable the following ones can use as `{{name}}`.
//!
//! - `GET  /api/ops/catalog` — the operations and their parameters.
//! - `POST /api/ops/run`     — run recipes against a set of variables.
//! - `POST /api/ops/render`  — run recipes, then fill a set of templates (a request's URL,
//!   headers, body…) from the variables and the recipes' outputs.

mod catalog;
mod codec;
mod crypto;
mod jwt;
mod step;
mod template;

use std::collections::HashMap;

use axum::{
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use codec::Shown;
use template::{render, Vars};

pub fn routes() -> Router {
    Router::new()
        .route(
            "/catalog",
            get(|| async { Json(json!({ "ops": catalog::CATALOG })) }),
        )
        .route("/run", post(run))
        .route("/render", post(render_templates))
        // inputs (a pasted document, a PEM) can be large; past this the request is refused
        .layer(axum::extract::DefaultBodyLimit::max(BODY_LIMIT))
}

/// Largest request body the engine accepts.
const BODY_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct RunReq {
    /// Starting variables, as text.
    #[serde(default)]
    pub vars: HashMap<String, String>,
    pub recipes: Vec<Recipe>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Recipe {
    /// Set: the output is stored as `{{name}}` for the recipes after it.
    #[serde(default)]
    pub name: String,
    /// The first step's input, a template.
    #[serde(default)]
    pub input: String,
    pub steps: Vec<Step>,
    /// Values this recipe falls back to for names the run's variables do not define.
    #[serde(default)]
    pub defaults: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Step {
    pub op: String,
    /// Parameter templates; a missing one takes the catalog default.
    #[serde(default)]
    pub params: HashMap<String, String>,
    /// Skipped, its input passed through: lets a step be switched off while editing.
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Serialize)]
pub struct RecipeResult {
    pub name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Shown>,
    pub steps: Vec<StepResult>,
}

#[derive(Debug, Serialize)]
pub struct StepResult {
    pub op: String,
    pub ok: bool,
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Shown>,
}

/// Run `recipes` in order. A recipe stops at its first failing step; the ones after it still
/// run, and fail in turn if they need its output.
pub fn run_recipes(
    vars: &HashMap<String, String>,
    recipes: &[Recipe],
) -> (Vars, Vec<RecipeResult>) {
    let mut vars: Vars = vars
        .iter()
        .map(|(k, v)| (k.clone(), v.as_bytes().to_vec()))
        .collect();
    let mut results = Vec::with_capacity(recipes.len());
    for recipe in recipes {
        let result = run_recipe(recipe, &vars);
        if let (true, Some(out)) = (!recipe.name.trim().is_empty(), result.1.as_ref()) {
            vars.insert(recipe.name.trim().to_string(), out.clone());
        }
        results.push(result.0);
    }
    (vars, results)
}

/// One recipe's report, and its output bytes when every step succeeded.
fn run_recipe(recipe: &Recipe, vars: &Vars) -> (RecipeResult, Option<Vec<u8>>) {
    let with_defaults;
    let vars = if recipe.defaults.is_empty() {
        vars
    } else {
        let mut merged = vars.clone();
        for (k, v) in &recipe.defaults {
            merged
                .entry(k.clone())
                .or_insert_with(|| v.as_bytes().to_vec());
        }
        with_defaults = merged;
        &with_defaults
    };
    let mut report = RecipeResult {
        name: recipe.name.trim().to_string(),
        ok: false,
        error: None,
        output: None,
        steps: Vec::with_capacity(recipe.steps.len()),
    };
    let mut data = match render(&recipe.input, vars) {
        Ok(text) => text.into_bytes(),
        Err(e) => {
            report.error = Some(format!("input: {e}"));
            return (report, None);
        }
    };
    for (i, s) in recipe.steps.iter().enumerate() {
        if s.disabled {
            report.steps.push(StepResult {
                op: s.op.clone(),
                ok: true,
                skipped: true,
                error: None,
                output: None,
            });
            continue;
        }
        match exec(s, vars, &data) {
            Ok(out) => {
                report.steps.push(StepResult {
                    op: s.op.clone(),
                    ok: true,
                    skipped: false,
                    error: None,
                    output: Some(Shown::of(&out)),
                });
                data = out;
            }
            Err(e) => {
                report.steps.push(StepResult {
                    op: s.op.clone(),
                    ok: false,
                    skipped: false,
                    error: Some(e.clone()),
                    output: None,
                });
                report.error = Some(format!("step {} ({}): {e}", i + 1, s.op));
                return (report, None);
            }
        }
    }
    report.ok = true;
    report.output = Some(Shown::of(&data));
    (report, Some(data))
}

/// Render the step's parameters, fill the defaults, run it. A parameter the form hides (its
/// `when` condition is false) takes its default, so a value left over from another mode
/// cannot change the result.
fn exec(s: &Step, vars: &Vars, input: &[u8]) -> Result<Vec<u8>, String> {
    let spec = catalog::find(&s.op).ok_or_else(|| format!("unknown operation `{}`", s.op))?;
    let given = |name: &str| {
        let default = spec
            .params
            .iter()
            .find(|p| p.name == name)
            .map_or("", |p| p.default);
        s.params.get(name).map_or(default, String::as_str)
    };
    let mut params = step::Params::new();
    for prm in spec.params {
        let shown = prm
            .when
            .map_or(true, |(other, values)| values.contains(&given(other)));
        let raw = if shown { given(prm.name) } else { prm.default };
        let value = render(raw, vars).map_err(|e| format!("{}: {e}", prm.label))?;
        params.insert(prm.name.to_string(), value);
    }
    step::run(&s.op, &params, input)
}

#[derive(Debug, Deserialize)]
pub struct RenderReq {
    #[serde(default)]
    pub vars: HashMap<String, String>,
    #[serde(default)]
    pub recipes: Vec<Recipe>,
    /// Templates by key, e.g. `url`, `header.x-sign`, `body`.
    pub templates: HashMap<String, String>,
}

/// Run `recipes`, then render every template. The first failure — a recipe or a template —
/// is the error, naming what failed. `computed` holds each named recipe's output as text, so
/// the caller can mask the secret ones wherever it shows what was sent.
pub fn render_all(req: &RenderReq) -> Result<Rendered, String> {
    let (vars, results) = run_recipes(&req.vars, &req.recipes);
    if let Some(failed) = results.iter().find(|r| !r.ok) {
        let what = if failed.name.is_empty() {
            "a recipe".to_string()
        } else {
            format!("`{}`", failed.name)
        };
        return Err(format!(
            "{what}: {}",
            failed.error.as_deref().unwrap_or("failed")
        ));
    }
    let mut computed = HashMap::new();
    for r in &results {
        if let Some(out) = vars.get(&r.name).filter(|_| !r.name.is_empty()) {
            let text = String::from_utf8(out.clone()).map_err(|_| {
                format!(
                    "`{}` is binary; end its recipe with an encoding step (hex / base64)",
                    r.name
                )
            })?;
            computed.insert(r.name.clone(), text);
        }
    }
    let mut rendered = HashMap::with_capacity(req.templates.len());
    for (key, template) in &req.templates {
        let value = render(template, &vars).map_err(|e| format!("{key}: {e}"))?;
        rendered.insert(key.clone(), value);
    }
    Ok(Rendered { rendered, computed })
}

/// What `render_all` produces.
#[derive(Debug)]
pub struct Rendered {
    /// The templates, filled in, by their keys.
    pub rendered: HashMap<String, String>,
    /// Each named recipe's output as text.
    pub computed: HashMap<String, String>,
}

async fn render_templates(Json(req): Json<RenderReq>) -> Json<Value> {
    let outcome = tokio::task::spawn_blocking(move || render_all(&req)).await;
    Json(match outcome {
        Ok(Ok(r)) => json!({ "ok": true, "rendered": r.rendered, "computed": r.computed }),
        Ok(Err(error)) => json!({ "ok": false, "error": error }),
        Err(e) => json!({ "ok": false, "error": format!("the render did not finish: {e}") }),
    })
}

async fn run(Json(req): Json<RunReq>) -> Json<Value> {
    // RSA key generation and large inputs are CPU-bound; keep them off the async workers.
    let outcome = tokio::task::spawn_blocking(move || run_recipes(&req.vars, &req.recipes)).await;
    match outcome {
        Ok((_, results)) => {
            let ok = results.iter().all(|r| r.ok);
            Json(json!({ "ok": ok, "results": results }))
        }
        Err(e) => Json(json!({ "ok": false, "error": format!("the run did not finish: {e}") })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(op: &str, params: &[(&str, &str)]) -> Step {
        Step {
            op: op.into(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            disabled: false,
        }
    }

    fn recipe(name: &str, input: &str, steps: Vec<Step>) -> Recipe {
        Recipe {
            name: name.into(),
            input: input.into(),
            steps,
            defaults: HashMap::new(),
        }
    }

    #[test]
    fn a_hidden_parameter_takes_its_default() {
        // key_encoding only shows for HS*: a leftover "hex" must not apply to RS256's PEM
        let (private, _) = crypto::rsa_generate(2048).unwrap();
        let s = step(
            "jwt.sign",
            &[("alg", "RS256"), ("key", &private), ("key_encoding", "hex")],
        );
        let (_, r) = run_recipes(&HashMap::new(), &[recipe("t", r#"{"a":1}"#, vec![s])]);
        assert!(r[0].ok, "{:?}", r[0].error);
    }

    #[test]
    fn a_recipes_defaults_fill_only_what_the_run_does_not_define() {
        let mut r = recipe("out", "{{a}}-{{b}}", vec![]);
        r.defaults = HashMap::from([
            ("a".to_string(), "fallback".to_string()),
            ("b".to_string(), "B".to_string()),
        ]);
        let vars = HashMap::from([("a".to_string(), "given".to_string())]);
        let (out, results) = run_recipes(&vars, &[r]);
        assert!(results[0].ok);
        assert_eq!(out["out"], b"given-B");
    }

    #[test]
    fn render_fills_templates_from_variables_and_recipe_outputs() {
        let req = RenderReq {
            vars: HashMap::from([("host".to_string(), "api.local".to_string())]),
            recipes: vec![recipe(
                "sig",
                "x",
                vec![step("hash", &[("alg", "md5")]), step("hex.encode", &[])],
            )],
            templates: HashMap::from([
                ("url".to_string(), "https://{{host}}/v1".to_string()),
                ("header.x-sign".to_string(), "{{sig}}".to_string()),
            ]),
        };
        let Rendered { rendered, computed } = render_all(&req).unwrap();
        assert_eq!(rendered["url"], "https://api.local/v1");
        assert_eq!(
            rendered["header.x-sign"],
            "9dd4e461268c8034f5c8564e155c67a6"
        );
        assert_eq!(computed["sig"], "9dd4e461268c8034f5c8564e155c67a6");
    }

    #[test]
    fn render_names_the_failing_recipe_or_template() {
        let bad_recipe = RenderReq {
            vars: HashMap::new(),
            recipes: vec![recipe("sig", "zz", vec![step("hex.decode", &[])])],
            templates: HashMap::new(),
        };
        assert!(render_all(&bad_recipe)
            .unwrap_err()
            .starts_with("`sig`: step 1 (hex.decode)"));
        let binary = RenderReq {
            vars: HashMap::new(),
            recipes: vec![recipe("raw", "x", vec![step("hash", &[])])],
            templates: HashMap::new(),
        };
        assert!(render_all(&binary).unwrap_err().contains("is binary"));
        let missing = RenderReq {
            vars: HashMap::new(),
            recipes: vec![],
            templates: HashMap::from([("body".to_string(), "{{nope}}".to_string())]),
        };
        assert_eq!(
            render_all(&missing).unwrap_err(),
            "body: unknown variable `nope`"
        );
    }

    /// A signature built only from general steps: a field joined from other variables, AES-CBC
    /// with hex key and IV, hex output.
    #[test]
    fn named_recipes_feed_the_ones_after_them() {
        let vars = HashMap::from([
            ("player".to_string(), "p1".to_string()),
            (
                "key".to_string(),
                "000102030405060708090a0b0c0d0e0f".to_string(),
            ),
        ]);
        let recipes = vec![
            recipe("ref", "", vec![step("text", &[("value", "R-1")])]),
            recipe(
                "sig",
                "{{player}}{{ref}}",
                vec![
                    step(
                        "aes.encrypt",
                        &[("mode", "cbc"), ("key", "{{key}}"), ("iv", "{{key}}")],
                    ),
                    step("hex.encode", &[]),
                ],
            ),
            recipe(
                "back",
                "{{sig}}",
                vec![
                    step("hex.decode", &[]),
                    step(
                        "aes.decrypt",
                        &[("mode", "cbc"), ("key", "{{key}}"), ("iv", "{{key}}")],
                    ),
                ],
            ),
        ];
        let (out, results) = run_recipes(&vars, &recipes);
        assert!(results.iter().all(|r| r.ok), "{results:?}");
        assert_eq!(
            out["back"], b"p1R-1",
            "decrypting the signature gives the joined input"
        );
        assert_eq!(results[1].steps.len(), 2);
        assert_eq!(
            results[1].output.as_ref().unwrap().size,
            32,
            "hex of one padded block"
        );
    }

    #[test]
    fn a_failing_step_is_reported_and_later_recipes_see_no_output() {
        let recipes = vec![
            recipe("a", "zz", vec![step("hex.decode", &[])]),
            recipe("b", "{{a}}", vec![]),
        ];
        let (_, results) = run_recipes(&HashMap::new(), &recipes);
        assert_eq!(
            results[0]
                .error
                .as_deref()
                .map(|e| e.starts_with("step 1 (hex.decode)")),
            Some(true)
        );
        assert_eq!(
            results[1].error.as_deref(),
            Some("input: unknown variable `a`")
        );
    }

    #[test]
    fn disabled_steps_pass_their_input_through_and_defaults_apply() {
        let mut off = step("base64.encode", &[]);
        off.disabled = true;
        let (out, results) = run_recipes(
            &HashMap::new(),
            &[recipe("x", "abc", vec![off, step("hash", &[])])],
        );
        assert!(results[0].steps[0].skipped);
        assert_eq!(
            hex::encode(&out["x"]),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn an_unknown_operation_or_variable_in_a_param_is_named() {
        let (_, r) = run_recipes(&HashMap::new(), &[recipe("", "", vec![step("nope", &[])])]);
        assert!(r[0]
            .error
            .as_deref()
            .unwrap()
            .contains("unknown operation `nope`"));
        let (_, r) = run_recipes(
            &HashMap::new(),
            &[recipe("", "x", vec![step("hmac", &[("key", "{{k}}")])])],
        );
        assert!(r[0]
            .error
            .as_deref()
            .unwrap()
            .contains("Key: unknown variable `k`"));
    }
}
