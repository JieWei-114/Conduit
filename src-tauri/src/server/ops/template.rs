//! `{{name}}` substitution. A name is letters, digits, `_`, `-` and `.`; spaces inside the
//! braces are allowed. An unknown name is an error rather than an empty string, so a typo
//! shows up instead of silently sending nothing. `\{{` is a literal `{{`.

use std::collections::HashMap;

/// Variables available to a template, by name. Values are bytes: a step can produce binary
/// output, which only becomes text through an encoding step.
pub type Vars = HashMap<String, Vec<u8>>;

/// `template` with every `{{name}}` replaced by its value as UTF-8 text.
pub fn render(template: &str, vars: &Vars) -> Result<String, String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        if rest[..start].ends_with('\\') {
            out.push_str(&rest[..start - 1]);
            out.push_str("{{");
            rest = &rest[start + 2..];
            continue;
        }
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return Err("`{{` without a closing `}}`".into());
        };
        let name = after[..end].trim();
        if !is_name(name) {
            return Err(format!("`{{{{{name}}}}}` is not a variable name"));
        }
        let value = vars
            .get(name)
            .ok_or_else(|| format!("unknown variable `{name}`"))?;
        let text = std::str::from_utf8(value).map_err(|_| {
            format!("variable `{name}` holds binary data; encode it (hex / base64) first")
        })?;
        out.push_str(text);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
            .collect()
    }

    #[test]
    fn replaces_every_reference_and_keeps_the_rest() {
        let v = vars(&[("a", "1"), ("b.c", "two")]);
        assert_eq!(render("x{{a}}y{{ b.c }}{{a}}", &v).unwrap(), "x1ytwo1");
        assert_eq!(render("no refs", &v).unwrap(), "no refs");
    }

    #[test]
    fn an_unknown_name_or_an_open_brace_is_an_error() {
        let v = vars(&[]);
        assert_eq!(
            render("{{missing}}", &v).unwrap_err(),
            "unknown variable `missing`"
        );
        assert!(render("{{oops", &v).is_err());
        assert!(render("{{a b}}", &v).is_err());
    }

    #[test]
    fn a_backslash_makes_braces_literal() {
        let v = vars(&[("a", "1")]);
        assert_eq!(render(r"\{{a}} is {{a}}", &v).unwrap(), "{{a}} is 1");
        assert_eq!(
            render("{{#each}}x", &v).unwrap_err(),
            "`{{#each}}` is not a variable name"
        );
        assert_eq!(
            render(r"\{{#each}}x\{{/each}}", &v).unwrap(),
            "{{#each}}x{{/each}}"
        );
    }

    #[test]
    fn binary_values_must_be_encoded_first() {
        let mut v = Vars::new();
        v.insert("raw".into(), vec![0xff, 0xfe]);
        assert!(render("{{raw}}", &v).unwrap_err().contains("binary"));
    }
}
