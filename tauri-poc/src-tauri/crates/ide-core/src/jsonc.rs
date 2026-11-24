//! JSON with comments (`devcontainer.json`, `deno.jsonc`, `tsconfig.json`): turned
//! into plain JSON for `serde_json`.

/// Strips `//` and `/* */` comments and trailing commas so JSONC parses as JSON.
pub fn strip(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    // Remove trailing commas before `}` / `]` (outside strings).
    let mut cleaned = String::with_capacity(out.len());
    let bytes: Vec<char> = out.chars().collect();
    let mut in_str = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            cleaned.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                cleaned.push(bytes[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            cleaned.push(c);
        } else if c == ',' {
            let next = bytes[i + 1..].iter().find(|ch| !ch.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                cleaned.push(c);
            }
        } else {
            cleaned.push(c);
        }
        i += 1;
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::strip;

    #[test]
    fn drops_comments_and_trailing_commas_outside_strings() {
        let src = "{\n  // line\n  \"a\": [1, 2,], /* block */\n  \"url\": \"https://x.dev//y /* no */\",\n  \"q\": \"say \\\"hi\\\",\",\n}\n";
        let v: serde_json::Value = serde_json::from_str(&strip(src)).unwrap();
        assert_eq!(v["a"], serde_json::json!([1, 2]));
        assert_eq!(v["url"], "https://x.dev//y /* no */");
        assert_eq!(v["q"], "say \"hi\",");
    }
}
