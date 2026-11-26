use serde::Serialize;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

use crate::web_bots::storage::{new_uuid_v4, now_ms, ExternalAgentKind, ExternalAgentRecord};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub status_code: Option<u16>,
    pub target_host: String,
    pub used_proxy: bool,
    pub message: String,
}

pub fn normalize_proxy_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(trimmed) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let parsed = Url::parse(trimmed).map_err(|e| format!("代理地址格式无效: {e}"))?;
    match parsed.scheme() {
        "http" | "https" | "socks5" | "socks5h" => Ok(Some(parsed.to_string())),
        other => Err(format!("不支持的代理协议: {other}（仅支持 http/https/socks5）")),
    }
}

pub async fn test_proxy(entry_url: &str, proxy_url: Option<&str>) -> ProxyTestResult {
    let parsed_target = Url::parse(entry_url).ok();
    let target_host = parsed_target
        .as_ref()
        .and_then(|u| u.host_str())
        .unwrap_or("unknown")
        .to_string();

    let clean_proxy = match normalize_proxy_url(proxy_url) {
        Ok(p) => p,
        Err(err) => {
            return ProxyTestResult {
                ok: false,
                latency_ms: 0,
                status_code: None,
                target_host,
                used_proxy: proxy_url.is_some_and(|s| !s.trim().is_empty()),
                message: err,
            };
        }
    };

    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(10));
    let used_proxy = clean_proxy.is_some();
    if let Some(ref proxy_str) = clean_proxy {
        match reqwest::Proxy::all(proxy_str) {
            Ok(proxy) => {
                builder = builder.proxy(proxy);
            }
            Err(e) => {
                return ProxyTestResult {
                    ok: false,
                    latency_ms: 0,
                    status_code: None,
                    target_host,
                    used_proxy: true,
                    message: format!("创建代理客户端失败: {e}"),
                };
            }
        }
    }

    let client = match builder.build() {
        Ok(c) => c,
        Err(e) => {
            return ProxyTestResult {
                ok: false,
                latency_ms: 0,
                status_code: None,
                target_host,
                used_proxy,
                message: format!("初始化 HTTP 客户端失败: {e}"),
            };
        }
    };

    let started = Instant::now();
    match client.get(entry_url).send().await {
        Ok(resp) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            let status = resp.status().as_u16();
            ProxyTestResult {
                ok: status < 500,
                latency_ms,
                status_code: Some(status),
                target_host,
                used_proxy,
                message: format!("连接成功 (HTTP {status}, {latency_ms} ms)"),
            }
        }
        Err(err) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            ProxyTestResult {
                ok: false,
                latency_ms,
                status_code: None,
                target_host,
                used_proxy,
                message: format!("连接失败: {err}"),
            }
        }
    }
}

pub fn normalize_external_agent_input(
    existing_id: Option<&str>,
    kind: ExternalAgentKind,
    name: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
    command: &str,
    args: Vec<String>,
    workdir: Option<&str>,
    existing_created_at: Option<u64>,
) -> Result<ExternalAgentRecord, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() || clean_name.len() > 64 {
        return Err("Agent 名称不能为空且不超过 64 个字符".to_string());
    }
    let id = existing_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(new_uuid_v4);
    let created_at_ms = existing_created_at.unwrap_or_else(now_ms);

    match kind {
        ExternalAgentKind::OpenaiApi => {
            let parsed =
                Url::parse(base_url.trim()).map_err(|e| format!("API Base URL 无效: {e}"))?;
            let is_local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
            if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_local) {
                return Err("API Base URL 必须使用 https://（仅本机允许 http://localhost）".to_string());
            }
            let clean_model = model.trim();
            if clean_model.is_empty() {
                return Err("请填写模型名称（例如 gpt-4o / deepseek-chat）".to_string());
            }
            let clean_base = parsed.to_string().trim_end_matches('/').to_string();
            Ok(ExternalAgentRecord {
                id,
                kind,
                name: clean_name.to_string(),
                base_url: clean_base,
                api_key: api_key.trim().to_string(),
                model: clean_model.to_string(),
                command: String::new(),
                args: Vec::new(),
                workdir: None,
                created_at_ms,
            })
        }
        ExternalAgentKind::LocalCli => {
            let clean_cmd = command.trim();
            if clean_cmd.is_empty() {
                return Err("本地 CLI 命令不能为空（例如 claude / codex）".to_string());
            }
            let clean_args: Vec<String> = args
                .into_iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            let clean_workdir = workdir
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned);
            Ok(ExternalAgentRecord {
                id,
                kind,
                name: clean_name.to_string(),
                base_url: String::new(),
                api_key: String::new(),
                model: String::new(),
                command: clean_cmd.to_string(),
                args: clean_args,
                workdir: clean_workdir,
                created_at_ms,
            })
        }
    }
}

pub fn build_openai_endpoint(base_url: &str) -> String {
    let clean = base_url.trim().trim_end_matches('/');
    if clean.ends_with("/chat/completions") {
        clean.to_string()
    } else {
        format!("{clean}/chat/completions")
    }
}

pub fn extract_openai_sse_delta(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let payload = trimmed.strip_prefix("data:").map(str::trim).unwrap_or(trimmed);
    if payload == "[DONE]" || !payload.starts_with('{') {
        return None;
    }
    let parsed: Value = serde_json::from_str(payload).ok()?;
    let choice = parsed.get("choices")?.as_array()?.first()?;
    if let Some(delta) = choice.get("delta").and_then(|d| d.get("content")).and_then(Value::as_str)
    {
        if !delta.is_empty() {
            return Some(delta.to_string());
        }
    }
    if let Some(content) = choice
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
    {
        if !content.is_empty() {
            return Some(content.to_string());
        }
    }
    None
}

pub async fn run_openai_stream<F>(
    agent: &ExternalAgentRecord,
    prompt: &str,
    mut on_progress: F,
) -> Result<String, String>
where
    F: FnMut(String) + Send,
{
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {e}"))?;

    let endpoint = build_openai_endpoint(&agent.base_url);
    let body = json!({
        "model": agent.model,
        "stream": true,
        "messages": [
            { "role": "user", "content": prompt }
        ]
    });

    let mut req = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .json(&body);
    if !agent.api_key.trim().is_empty() {
        req = req.bearer_auth(agent.api_key.trim());
    }

    let mut resp = req.send().await.map_err(|e| format!("请求 API 失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        let brief: String = err_text.chars().take(300).collect();
        return Err(format!("API 返回错误 ({status}): {brief}"));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !content_type.contains("text/event-stream") {
        let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
            if let Some(content) = parsed
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
            {
                return Ok(content.trim().to_string());
            }
        }
        return Err("API 响应格式非预期".to_string());
    }

    let mut acc = String::new();
    let mut pending_line = String::new();
    let mut last_emit = Instant::now() - Duration::from_secs(1);

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取流式响应中断: {e}"))?
    {
        let piece = String::from_utf8_lossy(&chunk);
        pending_line.push_str(&piece);
        while let Some(pos) = pending_line.find('\n') {
            let line: String = pending_line.drain(..=pos).collect();
            if let Some(delta) = extract_openai_sse_delta(&line) {
                acc.push_str(&delta);
                if last_emit.elapsed() >= Duration::from_millis(180) && !acc.trim().is_empty() {
                    last_emit = Instant::now();
                    on_progress(acc.clone());
                }
            }
        }
    }
    if let Some(delta) = extract_openai_sse_delta(&pending_line) {
        acc.push_str(&delta);
    }
    let final_text = acc.trim().to_string();
    if final_text.is_empty() {
        Err("API 未返回有效文本内容".to_string())
    } else {
        Ok(final_text)
    }
}

pub fn build_cli_args_and_stdin(args: &[String], prompt: &str) -> (Vec<String>, Option<String>) {
    let mut used_placeholder = false;
    let resolved: Vec<String> = args
        .iter()
        .map(|arg| {
            if arg.contains("{prompt}") {
                used_placeholder = true;
                arg.replace("{prompt}", prompt)
            } else {
                arg.clone()
            }
        })
        .collect();
    let stdin_payload = if used_placeholder {
        None
    } else {
        Some(prompt.to_string())
    };
    (resolved, stdin_payload)
}

pub async fn run_local_cli<F>(
    agent: &ExternalAgentRecord,
    prompt: &str,
    mut on_progress: F,
) -> Result<String, String>
where
    F: FnMut(String) + Send,
{
    let (args, stdin_payload) = build_cli_args_and_stdin(&agent.args, prompt);
    let mut cmd = tokio::process::Command::new(&agent.command);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_payload.is_some() {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    if let Some(ref workdir) = agent.workdir {
        cmd.current_dir(workdir);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动本地 CLI '{}' 失败: {e}", agent.command))?;

    if let Some(input) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
    }

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(ref mut err) = stderr {
            let _ = err.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).chars().take(300).collect::<String>()
    });

    let mut stdout_acc = String::new();
    let mut buf = [0u8; 4096];
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);

    loop {
        let Some(ref mut out) = stdout else {
            break;
        };
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            let _ = child.kill().await;
            return Err("本地 CLI 执行超时（120 秒）".to_string());
        }
        match tokio::time::timeout(remain, out.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                stdout_acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if last_emit.elapsed() >= Duration::from_millis(180)
                    && !stdout_acc.trim().is_empty()
                {
                    last_emit = Instant::now();
                    on_progress(stdout_acc.trim().to_string());
                }
            }
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return Err(format!("读取 CLI 输出失败: {e}"));
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err("本地 CLI 执行超时（120 秒）".to_string());
            }
        }
    }

    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| "等待 CLI 退出超时".to_string())?
        .map_err(|e| format!("等待 CLI 退出失败: {e}"))?;
    let err_detail = stderr_task.await.unwrap_or_default();
    let final_out = stdout_acc.trim().to_string();

    if !status.success() && final_out.is_empty() {
        return Err(if err_detail.trim().is_empty() {
            format!("本地 CLI 退出异常 ({status})")
        } else {
            format!("CLI 错误 ({status}): {}", err_detail.trim())
        });
    }
    if final_out.is_empty() {
        return Err(if err_detail.trim().is_empty() {
            "本地 CLI 未输出有效内容".to_string()
        } else {
            err_detail.trim().to_string()
        });
    }
    Ok(final_out)
}

#[cfg(test)]
mod tests {
    use super::{
        build_cli_args_and_stdin, build_openai_endpoint, extract_openai_sse_delta,
        normalize_external_agent_input, normalize_proxy_url,
    };
    use crate::web_bots::storage::ExternalAgentKind;

    #[test]
    fn openai_endpoint_and_sse_delta_parse_cleanly() {
        assert_eq!(
            build_openai_endpoint("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_openai_endpoint("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );

        let chunks = [
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Valkey-\"}}]}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"9921\"}}]}",
            "data: [DONE]",
        ];
        let combined: String = chunks
            .iter()
            .filter_map(|line| extract_openai_sse_delta(line))
            .collect();
        assert_eq!(combined, "Valkey-9921");
    }

    #[test]
    fn cli_args_placeholder_or_stdin_fallback() {
        let (args1, stdin1) =
            build_cli_args_and_stdin(&["-p".into(), "{prompt}".into()], "hello world");
        assert_eq!(args1, vec!["-p", "hello world"]);
        assert_eq!(stdin1, None);

        let (args2, stdin2) = build_cli_args_and_stdin(&["exec".into()], "hello world");
        assert_eq!(args2, vec!["exec"]);
        assert_eq!(stdin2.as_deref(), Some("hello world"));
    }

    #[test]
    fn normalize_external_agent_and_proxy_validate_inputs() {
        assert!(normalize_proxy_url(Some("ftp://127.0.0.1:8080")).is_err());
        assert_eq!(
            normalize_proxy_url(Some("http://127.0.0.1:7890")).expect("valid proxy"),
            Some("http://127.0.0.1:7890/".to_string())
        );

        let bad_url = normalize_external_agent_input(
            None,
            ExternalAgentKind::OpenaiApi,
            "BadApi",
            "http://example.com/v1",
            "sk-1",
            "gpt-4o",
            "",
            vec![],
            None,
            None,
        );
        assert!(bad_url.is_err());

        let local_ok = normalize_external_agent_input(
            None,
            ExternalAgentKind::OpenaiApi,
            "LocalOllama",
            "http://127.0.0.1:11434/v1/",
            "",
            "qwen2.5",
            "",
            vec![],
            None,
            None,
        )
        .expect("localhost http should succeed");
        assert_eq!(local_ok.base_url, "http://127.0.0.1:11434/v1");
    }
}
