use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::browser_webview::call_browser_devtools_protocol;
use crate::web_bots::providers::host_matches;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<String>,
    pub expires: Option<f64>,
}

fn normalize_same_site(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim().to_ascii_lowercase();
    match value.as_str() {
        "strict" => Some("Strict".to_string()),
        "lax" => Some("Lax".to_string()),
        "none" | "no_restriction" => Some("None".to_string()),
        _ => None,
    }
}

fn normalize_expires(raw: Option<f64>) -> Option<f64> {
    let exp = raw?;
    if !exp.is_finite() || exp <= 0.0 {
        return None;
    }
    if exp > 10_000_000_000.0 {
        Some(exp / 1000.0)
    } else {
        Some(exp)
    }
}

fn parse_json_cookies(raw: &str, default_domain: &str) -> Result<Vec<ParsedCookie>, String> {
    let val: Value = serde_json::from_str(raw).map_err(|e| format!("JSON Cookie 解析失败: {e}"))?;
    let arr = val
        .as_array()
        .ok_or_else(|| "JSON Cookie 必须是数组格式".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let Some(name) = obj.get("name").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        let Some(value) = obj.get("value").and_then(Value::as_str) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let domain = obj
            .get("domain")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .unwrap_or(default_domain)
            .to_string();
        let path = obj
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or("/")
            .to_string();
        let secure = obj.get("secure").and_then(Value::as_bool).unwrap_or(true);
        let http_only = obj
            .get("httpOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let same_site = normalize_same_site(obj.get("sameSite").and_then(Value::as_str));
        let expires = normalize_expires(
            obj.get("expirationDate")
                .and_then(Value::as_f64)
                .or_else(|| obj.get("expires").and_then(Value::as_f64)),
        );
        out.push(ParsedCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain,
            path,
            secure,
            http_only,
            same_site,
            expires,
        });
    }
    if out.is_empty() {
        return Err("JSON 数组中未找到有效 Cookie".to_string());
    }
    Ok(out)
}

fn parse_netscape_cookies(raw: &str) -> Result<Vec<ParsedCookie>, String> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (http_only, body) = if let Some(rest) = trimmed.strip_prefix("#HttpOnly_") {
            (true, rest)
        } else if trimmed.starts_with('#') {
            continue;
        } else {
            (false, trimmed)
        };
        let parts: Vec<&str> = body.split('\t').collect();
        if parts.len() < 7 {
            continue;
        }
        let domain = parts[0].trim();
        let path = parts[2].trim();
        let secure = parts[3].trim().eq_ignore_ascii_case("true");
        let expires = normalize_expires(parts[4].trim().parse::<f64>().ok());
        let name = parts[5].trim();
        let value = parts[6];
        if domain.is_empty() || name.is_empty() {
            continue;
        }
        out.push(ParsedCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain: domain.to_string(),
            path: if path.is_empty() { "/".to_string() } else { path.to_string() },
            secure,
            http_only,
            same_site: None,
            expires,
        });
    }
    if out.is_empty() {
        return Err("未解析出有效的 Netscape Cookie 条目".to_string());
    }
    Ok(out)
}

fn parse_header_cookies(raw: &str, default_domain: &str) -> Result<Vec<ParsedCookie>, String> {
    let stripped = raw
        .trim()
        .strip_prefix("Cookie:")
        .or_else(|| raw.trim().strip_prefix("cookie:"))
        .unwrap_or(raw.trim());
    let mut out = Vec::new();
    for pair in stripped.split(';') {
        let item = pair.trim();
        if item.is_empty() {
            continue;
        }
        let Some((name, value)) = item.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        out.push(ParsedCookie {
            name: name.to_string(),
            value: value.trim().to_string(),
            domain: default_domain.to_string(),
            path: "/".to_string(),
            secure: true,
            http_only: false,
            same_site: Some("Lax".to_string()),
            expires: None,
        });
    }
    if out.is_empty() {
        return Err("未解析出有效的 HTTP Cookie 请求头".to_string());
    }
    Ok(out)
}

pub fn parse_raw_cookies(raw: &str, default_domain: &str) -> Result<Vec<ParsedCookie>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Cookie 内容不能为空".to_string());
    }
    if trimmed.starts_with('[') {
        return parse_json_cookies(trimmed, default_domain);
    }
    if trimmed
        .lines()
        .any(|line| line.split('\t').count() >= 7 && !line.trim().starts_with('{'))
    {
        return parse_netscape_cookies(trimmed);
    }
    parse_header_cookies(trimmed, default_domain)
}

pub async fn inject_cookies_via_cdp(
    webview: &tauri::Webview<tauri::Wry>,
    cookies: &[ParsedCookie],
) -> Result<usize, String> {
    for chunk in cookies.chunks(200) {
        let cdp_cookies: Vec<Value> = chunk
            .iter()
            .map(|c| {
                let mut obj = serde_json::Map::new();
                obj.insert("name".into(), Value::String(c.name.clone()));
                obj.insert("value".into(), Value::String(c.value.clone()));
                obj.insert("domain".into(), Value::String(c.domain.clone()));
                obj.insert("path".into(), Value::String(c.path.clone()));
                obj.insert("secure".into(), Value::Bool(c.secure));
                obj.insert("httpOnly".into(), Value::Bool(c.http_only));
                if let Some(ref ss) = c.same_site {
                    obj.insert("sameSite".into(), Value::String(ss.clone()));
                }
                if let Some(exp) = c.expires {
                    obj.insert("expires".into(), json!(exp));
                }
                Value::Object(obj)
            })
            .collect();
        let params = json!({ "cookies": cdp_cookies }).to_string();
        let resp =
            call_browser_devtools_protocol(webview.clone(), "Network.setCookies", params).await?;
        if let Some(err) = resp.get("error") {
            return Err(format!("写入 Cookie 失败: {err}"));
        }
    }
    Ok(cookies.len())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedCookiesResult {
    pub json: String,
    pub count: usize,
    pub expires_at_ms: Option<u64>,
    pub session_only: bool,
}

pub async fn export_parsed_cookies_via_cdp(
    webview: &tauri::Webview<tauri::Wry>,
    allowed_hosts: &[String],
) -> Result<(Vec<ParsedCookie>, Option<u64>, bool), String> {
    let resp = call_browser_devtools_protocol(
        webview.clone(),
        "Network.getAllCookies",
        "{}".to_string(),
    )
    .await?;
    if let Some(err) = resp.get("error") {
        return Err(format!("读取 Cookie 失败: {err}"));
    }
    let all = resp
        .get("result")
        .and_then(|r| r.get("cookies"))
        .and_then(Value::as_array)
        .or_else(|| resp.get("cookies").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    let mut min_expires_ms: Option<u64> = None;
    let mut has_persistent = false;

    for entry in all {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let raw_domain = obj.get("domain").and_then(Value::as_str).unwrap_or_default();
        let clean_domain = raw_domain.trim_start_matches('.');
        if !allowed_hosts.is_empty()
            && !allowed_hosts
                .iter()
                .any(|allowed| host_matches(clean_domain, allowed))
        {
            continue;
        }
        let Some(name) = obj.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(value) = obj.get("value").and_then(Value::as_str) else {
            continue;
        };
        let expires = normalize_expires(obj.get("expires").and_then(Value::as_f64));
        if let Some(exp) = expires {
            has_persistent = true;
            let exp_ms = (exp * 1000.0) as u64;
            min_expires_ms = Some(match min_expires_ms {
                Some(prev) => prev.min(exp_ms),
                None => exp_ms,
            });
        }
        out.push(ParsedCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain: raw_domain.to_string(),
            path: obj
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("/")
                .to_string(),
            secure: obj.get("secure").and_then(Value::as_bool).unwrap_or(true),
            http_only: obj
                .get("httpOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            same_site: normalize_same_site(obj.get("sameSite").and_then(Value::as_str)),
            expires,
        });
    }

    let count = out.len();
    Ok((out, min_expires_ms, count > 0 && !has_persistent))
}

pub async fn export_cookies_via_cdp(
    webview: &tauri::Webview<tauri::Wry>,
    allowed_hosts: &[String],
) -> Result<ExportedCookiesResult, String> {
    let (cookies, expires_at_ms, session_only) =
        export_parsed_cookies_via_cdp(webview, allowed_hosts).await?;
    let count = cookies.len();
    let json = serde_json::to_string_pretty(&cookies)
        .map_err(|e| format!("序列化导出 Cookie 失败: {e}"))?;
    Ok(ExportedCookiesResult {
        json,
        count,
        expires_at_ms,
        session_only,
    })
}

pub async fn clear_cookies_via_cdp(webview: &tauri::Webview<tauri::Wry>) -> Result<(), String> {
    let resp = call_browser_devtools_protocol(
        webview.clone(),
        "Network.clearBrowserCookies",
        "{}".to_string(),
    )
    .await?;
    if let Some(err) = resp.get("error") {
        return Err(format!("清理 Cookie 失败: {err}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_raw_cookies;

    #[test]
    fn parses_json_netscape_and_http_header_cookies() {
        let json = r#"[{"name":"session","value":"abc","domain":".muse.ai","path":"/","secure":true,"httpOnly":true}]"#;
        let parsed = parse_raw_cookies(json, "muse.ai").expect("json");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "session");
        assert_eq!(parsed[0].domain, ".muse.ai");

        let netscape = "# Netscape HTTP Cookie File\n#HttpOnly_.muse.ai\tTRUE\t/\tTRUE\t1893456000\tsid\txyz\n";
        let parsed_net = parse_raw_cookies(netscape, "muse.ai").expect("netscape");
        assert_eq!(parsed_net.len(), 1);
        assert!(parsed_net[0].http_only);
        assert_eq!(parsed_net[0].value, "xyz");

        let header = "Cookie: a=1; b=2=3";
        let parsed_hdr = parse_raw_cookies(header, "muse.ai").expect("header");
        assert_eq!(parsed_hdr.len(), 2);
        assert_eq!(parsed_hdr[1].name, "b");
        assert_eq!(parsed_hdr[1].value, "2=3");
    }
}
