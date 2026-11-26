use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

use crate::browser_webview::{call_browser_devtools_protocol, store_identifier};
use crate::web_bots::site_adapters::{
    build_new_chat_script, build_poll_reply_script, build_probe_account_script,
    build_send_message_script, SiteAdapterConfig, WEB_BOT_CAPTURE_INIT_SCRIPT,
};
use crate::web_bots::storage::{AccountKey, AccountRecord};

const WEBBOT_LABEL_PREFIX: &str = "orca-webbot-";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebBotViewportBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

#[derive(Default)]
pub struct WebBotWebviewManager {
    labels: HashMap<String, String>,
    current_viewport: Option<WebBotViewportBounds>,
}

fn sanitize_label_part(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

pub fn make_webview_label(key: &AccountKey) -> String {
    format!(
        "{WEBBOT_LABEL_PREFIX}{}-{}",
        sanitize_label_part(&key.provider_id),
        sanitize_label_part(&key.uuid)
    )
}

pub fn account_profile_dir(app: &AppHandle, key: &AccountKey) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("无法获取应用本地数据目录: {e}"))?;
    Ok(base
        .join("web-bots-profiles")
        .join(sanitize_label_part(&key.provider_id))
        .join(sanitize_label_part(&key.uuid)))
}

impl WebBotWebviewManager {
    pub fn warm_accounts(&self) -> Vec<AccountKey> {
        self.labels
            .keys()
            .filter_map(|k| {
                let (provider_id, uuid) = k.split_once(':')?;
                Some(AccountKey {
                    provider_id: provider_id.to_string(),
                    uuid: uuid.to_string(),
                })
            })
            .collect()
    }

    pub fn get_webview(&self, app: &AppHandle, key: &AccountKey) -> Option<Webview<tauri::Wry>> {
        let label = self.labels.get(&key.composite_key())?;
        if let Some(wv) = app.get_webview(label) {
            return Some(wv);
        }
        None
    }

    pub fn ensure_webview(
        &mut self,
        app: &AppHandle,
        account: &AccountRecord,
        entry_url: &str,
        visible: bool,
    ) -> Result<(Webview<tauri::Wry>, bool), String> {
        let key = account.key();
        let composite = key.composite_key();
        if let Some(label) = self.labels.get(&composite) {
            if let Some(existing) = app.get_webview(label) {
                return Ok((existing, false));
            }
            self.labels.remove(&composite);
        }

        let main_window = app
            .get_window("main")
            .ok_or_else(|| "主窗口不可用".to_string())?;
        let parsed_url = Url::parse(entry_url).map_err(|e| format!("无效 URL: {e}"))?;
        let label = make_webview_label(&key);
        let profile_dir = account_profile_dir(app, &key)?;
        let _ = fs::create_dir_all(&profile_dir);

        let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed_url))
            .focused(false)
            .transparent(false)
            .zoom_hotkeys_enabled(false)
            .initialization_script(WEB_BOT_CAPTURE_INIT_SCRIPT)
            .data_store_identifier(store_identifier(&format!(
                "webbot:{}:{}",
                account.provider_id, account.uuid
            )));

        let app_for_popup = app.clone();
        let label_for_popup = label.clone();
        builder = builder.on_new_window(move |url, _| {
            if url.scheme() == "https" {
                if let Some(wv) = app_for_popup.get_webview(&label_for_popup) {
                    let _ = wv.navigate(url);
                }
            }
            NewWindowResponse::Deny
        });

        #[cfg(windows)]
        {
            // Give every Windows account its own WebView2 UserDataFolder for true cookie/storage isolation.
            builder = builder.data_directory(profile_dir);
        }

        if let Some(ref proxy_raw) = account.proxy_url {
            if let Ok(proxy_url) = Url::parse(proxy_raw) {
                builder = builder.proxy_url(proxy_url);
            }
        }

        let (pos, size) = match self.current_viewport {
            Some(vp) if vp.width > 10.0 && vp.height > 10.0 => (
                LogicalPosition::new(vp.x, vp.y),
                LogicalSize::new(vp.width, vp.height),
            ),
            _ => (
                LogicalPosition::new(320.0, 80.0),
                LogicalSize::new(1120.0, 760.0),
            ),
        };

        let child = main_window
            .add_child(builder, pos, size)
            .map_err(|e| format!("创建 Web Bot 视图失败: {e}"))?;
        if !visible {
            let _ = child.hide();
        }
        self.labels.insert(composite, label);
        Ok((child, true))
    }

    pub fn apply_viewport(
        &mut self,
        app: &AppHandle,
        active_key: Option<&AccountKey>,
        bounds: WebBotViewportBounds,
    ) {
        self.current_viewport = Some(bounds);
        let active_composite = active_key.map(AccountKey::composite_key);
        let mut stale = Vec::new();
        for (composite, label) in &self.labels {
            let Some(wv) = app.get_webview(label) else {
                stale.push(composite.clone());
                continue;
            };
            let is_active = active_composite.as_deref() == Some(composite.as_str());
            if is_active && bounds.visible && bounds.width > 10.0 && bounds.height > 10.0 {
                let _ = wv.set_position(LogicalPosition::new(bounds.x, bounds.y));
                let _ = wv.set_size(LogicalSize::new(bounds.width, bounds.height));
                let _ = wv.show();
            } else {
                let _ = wv.hide();
            }
        }
        for key in stale {
            self.labels.remove(&key);
        }
    }

    pub fn hide_all(&self, app: &AppHandle) {
        for label in self.labels.values() {
            if let Some(wv) = app.get_webview(label) {
                let _ = wv.hide();
            }
        }
    }

    pub fn close_webview(&mut self, app: &AppHandle, key: &AccountKey) {
        let composite = key.composite_key();
        if let Some(label) = self.labels.remove(&composite) {
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.hide();
                let _ = wv.close();
            }
        }
    }

    pub fn close_same_proxy_siblings(
        &mut self,
        app: &AppHandle,
        target: &AccountRecord,
        all_accounts: &[AccountRecord],
    ) {
        let target_proxy = target
            .proxy_url
            .as_deref()
            .map(str::trim)
            .unwrap_or("");
        for acc in all_accounts {
            if acc.provider_id != target.provider_id || acc.uuid == target.uuid {
                continue;
            }
            let acc_proxy = acc.proxy_url.as_deref().map(str::trim).unwrap_or("");
            if acc_proxy == target_proxy {
                self.close_webview(app, &acc.key());
            }
        }
    }
}

pub async fn remove_profile_directory(app: &AppHandle, key: &AccountKey) {
    let Ok(dir) = account_profile_dir(app, key) else {
        return;
    };
    if !dir.exists() {
        return;
    }
    // WebView2 releases file locks asynchronously after close().
    for _ in 0..6 {
        if fs::remove_dir_all(&dir).is_ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

pub async fn eval_cdp_json(webview: &Webview<tauri::Wry>, script: &str) -> Result<Value, String> {
    let params = json!({
        "expression": script,
        "awaitPromise": true,
        "returnByValue": true
    })
    .to_string();
    let resp = call_browser_devtools_protocol(webview.clone(), "Runtime.evaluate", params).await?;
    if let Some(err) = resp.get("error") {
        return Err(format!("CDP 评估失败: {err}"));
    }
    if let Some(exc) = resp.get("exceptionDetails") {
        return Err(format!("页面脚本异常: {exc}"));
    }
    let raw_val = resp
        .pointer("/result/result/value")
        .or_else(|| resp.pointer("/result/value"))
        .or_else(|| resp.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
    match raw_val {
        Value::String(s) => {
            serde_json::from_str::<Value>(&s).or_else(|_| Ok(Value::String(s)))
        }
        other => Ok(other),
    }
}

#[derive(Debug, Clone)]
pub struct AccountProbeResult {
    pub url: Option<String>,
    pub email: Option<String>,
    pub authenticated: bool,
    pub quota_text: Option<String>,
    pub quota_percent: Option<f64>,
}

pub async fn apply_timezone_override(
    webview: &Webview<tauri::Wry>,
    timezone: Option<&str>,
) -> Result<(), String> {
    let Some(tz) = timezone.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let params = json!({ "timezoneId": tz }).to_string();
    let _ = call_browser_devtools_protocol(
        webview.clone(),
        "Emulation.setTimezoneOverride",
        params,
    )
    .await?;
    Ok(())
}

pub async fn probe_account_webview(
    webview: &Webview<tauri::Wry>,
) -> Result<AccountProbeResult, String> {
    let val = eval_cdp_json(webview, build_probe_account_script()).await?;
    let url = val
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let email = val
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let authenticated = val
        .get("authenticated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let quota_text = val
        .get("quotaText")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let quota_percent = val
        .get("quotaPercent")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && (0.0..=100.0).contains(v));
    Ok(AccountProbeResult {
        url,
        email,
        authenticated,
        quota_text,
        quota_percent,
    })
}

pub async fn navigate_account_webview(
    webview: &Webview<tauri::Wry>,
    action: &str,
    url: Option<&str>,
    fallback_home: &str,
) -> Result<Option<String>, String> {
    match action {
        "back" => {
            let _ = eval_cdp_json(webview, "window.history.back(); null").await?;
        }
        "forward" => {
            let _ = eval_cdp_json(webview, "window.history.forward(); null").await?;
        }
        "home" => {
            let parsed = Url::parse(fallback_home).map_err(|e| format!("主页地址无效: {e}"))?;
            webview
                .navigate(parsed)
                .map_err(|e| format!("返回主页失败: {e}"))?;
        }
        "url" => {
            let raw = url.map(str::trim).filter(|s| !s.is_empty()).ok_or("缺少目标 URL")?;
            let parsed = Url::parse(raw).map_err(|e| format!("URL 格式无效: {e}"))?;
            let is_local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
            if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_local) {
                return Err("仅支持跳转 https:// 或本机地址".to_string());
            }
            webview
                .navigate(parsed)
                .map_err(|e| format!("页面跳转失败: {e}"))?;
        }
        other => return Err(format!("未知导航动作: {other}")),
    }
    Ok(webview.url().ok().map(|u| u.to_string()))
}

pub async fn navigate_and_wait_ready(
    webview: &Webview<tauri::Wry>,
    target_url: Option<&str>,
) -> Result<(), String> {
    if let Some(url_str) = target_url {
        if let Ok(parsed) = Url::parse(url_str) {
            let current = webview.url().ok().map(|u| u.to_string());
            if current.as_deref() != Some(parsed.as_str()) {
                webview
                    .navigate(parsed)
                    .map_err(|e| format!("页面跳转失败: {e}"))?;
                tokio::time::sleep(Duration::from_millis(800)).await;
            }
        }
    }
    for _ in 0..24 {
        if let Ok(val) = eval_cdp_json(webview, "document.readyState").await {
            if matches!(val.as_str(), Some("interactive" | "complete")) {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

pub async fn reset_web_bot_chat(
    webview: &Webview<tauri::Wry>,
    adapter: &SiteAdapterConfig,
    fallback_url: &str,
) -> Result<(), String> {
    let script = build_new_chat_script(adapter);
    let res = eval_cdp_json(webview, &script).await?;
    if !res.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        if let Ok(parsed) = Url::parse(fallback_url) {
            let _ = webview.navigate(parsed);
        }
    }
    Ok(())
}

pub enum WebBotReplyError {
    NeedsAuth(String),
    Other(String),
}

pub async fn send_and_collect_web_bot_reply<F>(
    webview: &Webview<tauri::Wry>,
    adapter: &SiteAdapterConfig,
    prompt: &str,
    thread_url: Option<&str>,
    mut on_progress: F,
) -> Result<(String, Option<String>), WebBotReplyError>
where
    F: FnMut(String) + Send,
{
    navigate_and_wait_ready(webview, thread_url)
        .await
        .map_err(WebBotReplyError::Other)?;

    // Wait briefly for SPA composer hydration if freshly navigated.
    let mut send_result = Value::Null;
    for attempt in 0..10 {
        let script = build_send_message_script(adapter, prompt);
        send_result = eval_cdp_json(webview, &script)
            .await
            .map_err(WebBotReplyError::Other)?;
        if send_result.get("needsAuth").and_then(Value::as_bool).unwrap_or(false) {
            let msg = send_result
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("请先完成该账号登录认证")
                .to_string();
            return Err(WebBotReplyError::NeedsAuth(msg));
        }
        if send_result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            break;
        }
        if attempt < 9 {
            tokio::time::sleep(Duration::from_millis(450)).await;
        }
    }
    if !send_result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let err = send_result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("发送消息失败")
            .to_string();
        return Err(WebBotReplyError::Other(err));
    }

    let baseline_count = send_result
        .get("baselineCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;

    let started = Instant::now();
    let max_wait = Duration::from_secs(180);
    let mut last_text = String::new();
    let mut last_change = Instant::now();
    let mut last_url: Option<String> = None;

    loop {
        tokio::time::sleep(Duration::from_millis(600)).await;
        if started.elapsed() > max_wait {
            if !last_text.trim().is_empty() {
                return Ok((last_text.trim().to_string(), last_url));
            }
            return Err(WebBotReplyError::Other("等待网页 Bot 回复超时（180 秒）".to_string()));
        }

        let poll_script = build_poll_reply_script(adapter, baseline_count);
        let Ok(poll) = eval_cdp_json(webview, &poll_script).await else {
            continue;
        };
        if poll.get("needsAuth").and_then(Value::as_bool).unwrap_or(false) {
            return Err(WebBotReplyError::NeedsAuth(
                "检测到页面跳转至登录认证".to_string(),
            ));
        }
        if let Some(u) = poll.get("url").and_then(Value::as_str) {
            if !u.is_empty() {
                last_url = Some(u.to_string());
            }
        }
        let text = poll
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let streaming = poll.get("streaming").and_then(Value::as_bool).unwrap_or(false);

        if text != last_text {
            last_text = text.clone();
            last_change = Instant::now();
            if !last_text.is_empty() {
                on_progress(last_text.clone());
            }
        }

        if !last_text.is_empty() && !streaming && last_change.elapsed() >= Duration::from_millis(2400)
        {
            return Ok((last_text, last_url));
        }
        if last_text.is_empty() && !streaming && started.elapsed() >= Duration::from_secs(25) {
            return Err(WebBotReplyError::Other(
                "未检测到回复内容（请检查站点选择器或账号登录状态）".to_string(),
            ));
        }
    }
}
