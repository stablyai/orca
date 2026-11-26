use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const OVERRIDES_FILE_NAME: &str = "web-bots-site-adapters.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteAdapterConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub host_patterns: Vec<String>,
    #[serde(default)]
    pub composer_selectors: Vec<String>,
    #[serde(default)]
    pub send_button_selectors: Vec<String>,
    #[serde(default)]
    pub stop_button_selectors: Vec<String>,
    #[serde(default)]
    pub message_list_selectors: Vec<String>,
    #[serde(default)]
    pub assistant_message_selectors: Vec<String>,
    #[serde(default)]
    pub new_chat_selectors: Vec<String>,
    #[serde(default)]
    pub new_chat_url: Option<String>,
    #[serde(default)]
    pub thread_url_patterns: Vec<String>,
    #[serde(default)]
    pub transient_status_words: Vec<String>,
    #[serde(default)]
    pub chat_api_patterns: Vec<String>,
    #[serde(default)]
    pub prefer_enter_submit: bool,
    #[serde(default)]
    pub async_agent: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteAdaptersSnapshot {
    pub adapters: Vec<SiteAdapterConfig>,
    pub override_path: String,
    pub has_overrides: bool,
    pub override_json: String,
}

fn svec(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

pub fn builtin_site_adapters() -> Vec<SiteAdapterConfig> {
    vec![
        SiteAdapterConfig {
            id: "muse".to_string(),
            name: "Muse · Meta".to_string(),
            host_patterns: svec(&["muse.ai", "*.muse.ai"]),
            composer_selectors: svec(&[
                "textarea[placeholder*=\"消息\"]",
                "textarea[placeholder*=\"Message\" i]",
                "textarea",
                "[contenteditable=\"true\"]",
            ]),
            send_button_selectors: svec(&[
                "button[aria-label*=\"发送\"]",
                "button[title*=\"发送\"]",
                "button[aria-label*=\"Send\" i]",
                "button[type=\"submit\"]",
            ]),
            stop_button_selectors: svec(&[
                "button[aria-label*=\"停止\"]",
                "button[aria-label*=\"Stop\" i]",
                "button[data-testid*=\"stop\" i]",
            ]),
            message_list_selectors: svec(&["[data-testid=\"message-list\"]", "main"]),
            assistant_message_selectors: svec(&[
                "[data-message-author-role=\"assistant\"]",
                "[data-testid*=\"assistant\" i]",
            ]),
            new_chat_selectors: svec(&[
                "a[href=\"/\"]",
                "button[aria-label*=\"新建\"]",
                "button[aria-label*=\"New\" i]",
            ]),
            new_chat_url: Some("https://muse.ai/".to_string()),
            thread_url_patterns: Vec::new(),
            transient_status_words: svec(&[
                "正在预热",
                "预热中",
                "空闲中",
                "已连接",
                "连接中",
                "正在连接",
                "仍在发送中",
                "发送中",
                "努力工作中",
                "工作中",
                "努力思考中",
                "思考中",
                "Thinking",
            ]),
            chat_api_patterns: Vec::new(),
            prefer_enter_submit: true,
            async_agent: false,
        },
        SiteAdapterConfig {
            id: "hark".to_string(),
            name: "Hark".to_string(),
            host_patterns: svec(&["app.hark.com", "hark.com", "*.hark.com"]),
            composer_selectors: svec(&[
                "textarea",
                "[contenteditable=\"true\"]",
                "[role=\"textbox\"]",
            ]),
            send_button_selectors: svec(&[
                "button[aria-label*=\"Send\" i]",
                "button[aria-label*=\"发送\"]",
                "button[type=\"submit\"]",
            ]),
            stop_button_selectors: svec(&[
                "button[aria-label*=\"Stop\" i]",
                "button[data-testid*=\"stop\" i]",
            ]),
            message_list_selectors: svec(&["main", "[role=\"log\"]"]),
            assistant_message_selectors: svec(&[
                "[data-message-author-role=\"assistant\"]",
                "[data-testid*=\"assistant\" i]",
                ".markdown",
            ]),
            new_chat_selectors: svec(&[
                "button[aria-label*=\"New\" i]",
                "a[href*=\"new\" i]",
            ]),
            new_chat_url: Some("https://app.hark.com/".to_string()),
            thread_url_patterns: Vec::new(),
            transient_status_words: svec(&["Thinking", "Generating", "思考中", "生成中"]),
            chat_api_patterns: Vec::new(),
            prefer_enter_submit: true,
            async_agent: false,
        },
        SiteAdapterConfig {
            id: "generic".to_string(),
            name: "Generic Web Bot".to_string(),
            host_patterns: svec(&["*"]),
            composer_selectors: svec(&[
                "textarea:not([disabled])",
                "[contenteditable=\"true\"]",
                "[role=\"textbox\"]",
            ]),
            send_button_selectors: svec(&[
                "button[type=\"submit\"]",
                "button[aria-label*=\"Send\" i]",
                "button[aria-label*=\"发送\"]",
                "button[data-testid*=\"send\" i]",
            ]),
            stop_button_selectors: svec(&[
                "button[aria-label*=\"Stop\" i]",
                "button[aria-label*=\"停止\"]",
                "button[data-testid*=\"stop\" i]",
            ]),
            message_list_selectors: svec(&["main", "[role=\"log\"]", "[role=\"main\"]"]),
            assistant_message_selectors: svec(&[
                "[data-message-author-role=\"assistant\"]",
                "[data-testid*=\"assistant\" i]",
                "[class*=\"assistant\" i]",
                "article",
            ]),
            new_chat_selectors: svec(&[
                "button[aria-label*=\"New\" i]",
                "button[aria-label*=\"新建\"]",
            ]),
            new_chat_url: None,
            thread_url_patterns: Vec::new(),
            transient_status_words: svec(&["Thinking", "Generating", "思考中", "生成中"]),
            chat_api_patterns: Vec::new(),
            prefer_enter_submit: true,
            async_agent: false,
        },
    ]
}

fn override_file_path(dir: &Path) -> PathBuf {
    dir.join(OVERRIDES_FILE_NAME)
}

fn pattern_matches_host(pattern: &str, host: &str) -> bool {
    let p = pattern.trim().to_ascii_lowercase();
    let h = host.trim().to_ascii_lowercase();
    if p == "*" {
        return true;
    }
    if let Some(suffix) = p.strip_prefix("*.") {
        return h == suffix || h.ends_with(&format!(".{suffix}"));
    }
    h == p || h.ends_with(&format!(".{p}"))
}

pub fn load_adapters(dir: &Path) -> (Vec<SiteAdapterConfig>, bool, String) {
    let path = override_file_path(dir);
    let mut merged = builtin_site_adapters();
    let Ok(raw) = fs::read_to_string(&path) else {
        return (merged, false, String::new());
    };
    let Ok(overrides) = serde_json::from_str::<Vec<SiteAdapterConfig>>(&raw) else {
        return (merged, false, raw);
    };
    for custom in overrides {
        if let Some(existing) = merged.iter_mut().find(|item| item.id == custom.id) {
            *existing = custom;
        } else {
            // Insert custom overrides ahead of the generic fallback.
            let insert_idx = merged.len().saturating_sub(1);
            merged.insert(insert_idx, custom);
        }
    }
    (merged, true, raw)
}

pub fn resolve_adapter_for_host(dir: &Path, host: &str) -> SiteAdapterConfig {
    let (adapters, _, _) = load_adapters(dir);
    adapters
        .iter()
        .find(|adapter| {
            adapter.id != "generic"
                && adapter
                    .host_patterns
                    .iter()
                    .any(|pattern| pattern_matches_host(pattern, host))
        })
        .cloned()
        .or_else(|| adapters.into_iter().find(|adapter| adapter.id == "generic"))
        .unwrap_or_else(|| builtin_site_adapters().pop().expect("generic adapter"))
}

pub fn get_adapters_snapshot(dir: &Path) -> SiteAdaptersSnapshot {
    let path = override_file_path(dir);
    let (adapters, has_overrides, override_json) = load_adapters(dir);
    SiteAdaptersSnapshot {
        adapters,
        override_path: path.to_string_lossy().into_owned(),
        has_overrides,
        override_json,
    }
}

pub fn validate_and_save_overrides(
    dir: &Path,
    raw_json: &str,
) -> Result<SiteAdaptersSnapshot, String> {
    let parsed: Vec<SiteAdapterConfig> = serde_json::from_str(raw_json.trim())
        .map_err(|e| format!("站点适配器 JSON 格式无效: {e}"))?;
    for item in &parsed {
        if item.id.trim().is_empty() {
            return Err("适配器条目缺少 id 字段".to_string());
        }
    }
    fs::create_dir_all(dir).map_err(|e| format!("创建适配器目录失败: {e}"))?;
    let formatted =
        serde_json::to_string_pretty(&parsed).map_err(|e| format!("序列化适配器失败: {e}"))?;
    let path = override_file_path(dir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, formatted).map_err(|e| format!("写入适配器临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存适配器覆盖文件失败: {e}"))?;
    Ok(get_adapters_snapshot(dir))
}

pub fn reset_overrides(dir: &Path) -> Result<SiteAdaptersSnapshot, String> {
    let path = override_file_path(dir);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除适配器覆盖文件失败: {e}"))?;
    }
    Ok(get_adapters_snapshot(dir))
}

/// Initialization script injected into every Web Bot child WebView to capture
/// streaming fetch / SSE / WebSocket responses without altering page behavior.
pub const WEB_BOT_CAPTURE_INIT_SCRIPT: &str = r#"(() => {
  try {
    if (window.__ORCA_WEB_BOT_CAPTURE__) return;
    const TELEMETRY_RE = /telemetry|analytics|sentry|logging|heartbeat|metrics|beacon|datadog/i;
    const state = {
      fetchText: '',
      fetchLastAt: 0,
      esText: '',
      esLastAt: 0,
      wsText: '',
      wsLastAt: 0,
      reset() {
        this.fetchText = '';
        this.fetchLastAt = 0;
        this.esText = '';
        this.esLastAt = 0;
        this.wsText = '';
        this.wsLastAt = 0;
      }
    };
    window.__ORCA_WEB_BOT_CAPTURE__ = state;

    function pickTextFromJson(obj) {
      if (!obj || typeof obj !== 'object') return '';
      if (Array.isArray(obj.choices) && obj.choices[0]) {
        const c = obj.choices[0];
        if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
        if (c.message && typeof c.message.content === 'string') return '\x00REPLACE:' + c.message.content;
      }
      if (typeof obj.delta === 'string') return obj.delta;
      if (obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.content === 'string') return obj.content;
      if (obj.message && typeof obj.message.content === 'string') return '\x00REPLACE:' + obj.message.content;
      return '';
    }

    function consumeChunkText(chunk, targetKey) {
      if (!chunk) return;
      const lines = chunk.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (!payload || payload === '[DONE]') continue;
        if (payload.startsWith('{') || payload.startsWith('[')) {
          try {
            const parsed = JSON.parse(payload);
            const piece = pickTextFromJson(parsed);
            if (piece.startsWith('\x00REPLACE:')) state[targetKey] = piece.slice(9);
            else if (piece) state[targetKey] += piece;
          } catch (_) {}
        }
      }
    }

    if (typeof window.fetch === 'function') {
      const origFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const res = await origFetch(...args);
        try {
          const url = String(args[0] && args[0].url ? args[0].url : args[0] || '');
          const ct = (res.headers && res.headers.get('content-type')) || '';
          if (!TELEMETRY_RE.test(url) && (ct.includes('event-stream') || ct.includes('json') || ct.includes('ndjson'))) {
            const cloned = res.clone();
            if (cloned.body && cloned.body.getReader) {
              const reader = cloned.body.getReader();
              const decoder = new TextDecoder();
              (async () => {
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  state.fetchLastAt = Date.now();
                  consumeChunkText(decoder.decode(value, { stream: true }), 'fetchText');
                }
              })().catch(() => {});
            }
          }
        } catch (_) {}
        return res;
      };
    }

    if (typeof window.EventSource === 'function') {
      const OrigES = window.EventSource;
      window.EventSource = new Proxy(OrigES, {
        construct(target, args, newTarget) {
          const es = Reflect.construct(target, args, newTarget);
          try {
            const u = String(args && args[0] ? args[0] : '');
            if (!TELEMETRY_RE.test(u)) {
              es.addEventListener('message', (ev) => {
                state.esLastAt = Date.now();
                consumeChunkText(String(ev && ev.data ? ev.data : ''), 'esText');
              });
            }
          } catch (_) {}
          return es;
        }
      });
    }

    if (typeof window.WebSocket === 'function') {
      const OrigWS = window.WebSocket;
      window.WebSocket = new Proxy(OrigWS, {
        construct(target, args, newTarget) {
          const ws = Reflect.construct(target, args, newTarget);
          try {
            const u = String(args && args[0] ? args[0] : '');
            if (!TELEMETRY_RE.test(u)) {
              ws.addEventListener('message', (ev) => {
                state.wsLastAt = Date.now();
                if (typeof ev.data === 'string' && ev.data.startsWith('{')) {
                  consumeChunkText(ev.data, 'wsText');
                }
              });
            }
          } catch (_) {}
          return ws;
        }
      });
    }
  } catch (_) {}
})();"#;

pub fn build_send_message_script(adapter: &SiteAdapterConfig, prompt: &str) -> String {
    let adapter_json = serde_json::to_string(adapter).unwrap_or_else(|_| "{}".to_string());
    let prompt_json = serde_json::to_string(prompt).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(() => {{
  const adapter = {adapter_json};
  const promptText = {prompt_json};
  const href = location.href || '';
  if (/login|signin|sign-in|auth|oauth|accounts\.google|appleid\.apple/i.test(href) && !document.querySelector('textarea')) {{
    return JSON.stringify({{ ok: false, needsAuth: true, error: '当前页面需要先完成登录认证' }});
  }}
  if (window.__ORCA_WEB_BOT_CAPTURE__ && typeof window.__ORCA_WEB_BOT_CAPTURE__.reset === 'function') {{
    window.__ORCA_WEB_BOT_CAPTURE__.reset();
  }}
  function isVisible(el) {{
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }}
  function findFirst(selectors) {{
    for (const sel of (selectors || [])) {{
      try {{
        const list = document.querySelectorAll(sel);
        for (const el of list) {{
          if (isVisible(el)) return el;
        }}
      }} catch (_) {{}}
    }}
    return null;
  }}
  function countAssistantMessages() {{
    let maxCount = 0;
    for (const sel of (adapter.assistantMessageSelectors || [])) {{
      try {{
        const len = document.querySelectorAll(sel).length;
        if (len > maxCount) maxCount = len;
      }} catch (_) {{}}
    }}
    return maxCount;
  }}
  const composer = findFirst(adapter.composerSelectors);
  if (!composer) {{
    return JSON.stringify({{ ok: false, needsAuth: false, error: '未找到消息输入框，请确认页面已加载并登录' }});
  }}
  const baselineCount = countAssistantMessages();
  composer.focus();
  if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {{
    const proto = composer.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(composer, promptText);
    else composer.value = promptText;
    composer.dispatchEvent(new Event('input', {{ bubbles: true }}));
    composer.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }} else {{
    try {{
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, promptText);
    }} catch (_) {{
      composer.textContent = promptText;
    }}
    composer.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: promptText }}));
  }}

  const sendBtn = findFirst(adapter.sendButtonSelectors);
  if (sendBtn && !sendBtn.disabled) {{
    sendBtn.click();
  }} else if (adapter.preferEnterSubmit) {{
    const evInit = {{ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }};
    composer.dispatchEvent(new KeyboardEvent('keydown', evInit));
    composer.dispatchEvent(new KeyboardEvent('keypress', evInit));
    composer.dispatchEvent(new KeyboardEvent('keyup', evInit));
  }} else if (sendBtn) {{
    sendBtn.click();
  }} else {{
    return JSON.stringify({{ ok: false, needsAuth: false, error: '未找到可点击的发送按钮' }});
  }}
  return JSON.stringify({{ ok: true, needsAuth: false, baselineCount, url: href }});
}})()"#
    )
}

pub fn build_poll_reply_script(adapter: &SiteAdapterConfig, baseline_count: usize) -> String {
    let adapter_json = serde_json::to_string(adapter).unwrap_or_else(|_| "{}".to_string());
    format!(
        r#"(() => {{
  const adapter = {adapter_json};
  const baseline = {baseline_count};
  const href = location.href || '';
  if (/login|signin|sign-in|auth|oauth/i.test(href) && !document.querySelector('textarea')) {{
    return JSON.stringify({{ text: '', streaming: false, url: href, needsAuth: true }});
  }}
  function isVisible(el) {{
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }}
  let stopVisible = false;
  for (const sel of (adapter.stopButtonSelectors || [])) {{
    try {{
      for (const el of document.querySelectorAll(sel)) {{
        if (isVisible(el)) {{ stopVisible = true; break; }}
      }}
    }} catch (_) {{}}
    if (stopVisible) break;
  }}

  let domText = '';
  for (const sel of (adapter.assistantMessageSelectors || [])) {{
    try {{
      const nodes = Array.from(document.querySelectorAll(sel));
      if (nodes.length > baseline) {{
        const last = nodes[nodes.length - 1];
        const candidate = (last.innerText || last.textContent || '').trim();
        if (candidate) {{
          domText = candidate;
          break;
        }}
      }}
    }} catch (_) {{}}
  }}

  const transient = new Set((adapter.transientStatusWords || []).map(w => w.trim()));
  if (domText && transient.has(domText.trim())) {{
    domText = '';
    stopVisible = true;
  }}

  const cap = window.__ORCA_WEB_BOT_CAPTURE__ || {{}};
  const captured = [cap.fetchText || '', cap.esText || '', cap.wsText || '']
    .map(s => s.trim())
    .sort((a, b) => b.length - a.length)[0] || '';
  const recentNet = Math.max(cap.fetchLastAt || 0, cap.esLastAt || 0, cap.wsLastAt || 0);
  const netActive = recentNet > 0 && (Date.now() - recentNet) < 1500;
  const text = domText.length >= captured.length ? domText : captured;
  return JSON.stringify({{
    text,
    streaming: Boolean(stopVisible || netActive),
    url: href,
    needsAuth: false
  }});
}})()"#
    )
}

pub fn build_new_chat_script(adapter: &SiteAdapterConfig) -> String {
    let adapter_json = serde_json::to_string(adapter).unwrap_or_else(|_| "{}".to_string());
    format!(
        r#"(() => {{
  const adapter = {adapter_json};
  for (const sel of (adapter.newChatSelectors || [])) {{
    try {{
      const el = document.querySelector(sel);
      if (el) {{
        el.click();
        return JSON.stringify({{ ok: true }});
      }}
    }} catch (_) {{}}
  }}
  if (adapter.newChatUrl) {{
    location.href = adapter.newChatUrl;
    return JSON.stringify({{ ok: true }});
  }}
  return JSON.stringify({{ ok: false }});
}})()"#
    )
}

pub fn build_probe_account_script() -> &'static str {
    r#"(() => {
  const href = location.href || '';
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 6000);
  const emailMatch = bodyText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const hasLoginForm = Boolean(document.querySelector('input[type="password"]'))
    || /login|signin|sign-in/i.test(href);
  const hasComposer = Boolean(document.querySelector('textarea, [contenteditable="true"]'));

  let quotaText = null;
  let quotaPercent = null;
  const quotaLine = bodyText
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.length <= 80 && /(quota|usage|credit|limit|额度|用量|剩余)/i.test(l) && /\d/.test(l));
  if (quotaLine) {
    quotaText = quotaLine;
    const pctMatch = quotaLine.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (pctMatch) {
      const val = Number.parseFloat(pctMatch[1]);
      if (Number.isFinite(val) && val >= 0 && val <= 100) quotaPercent = val;
    } else {
      const fracMatch = quotaLine.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
      if (fracMatch) {
        const used = Number.parseFloat(fracMatch[1]);
        const total = Number.parseFloat(fracMatch[2]);
        if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
          quotaPercent = Math.max(0, Math.min(100, (used / total) * 100));
        }
      }
    }
  }

  return JSON.stringify({
    url: href,
    title: document.title || '',
    email: emailMatch ? emailMatch[0] : null,
    authenticated: hasComposer && !hasLoginForm,
    quotaText,
    quotaPercent
  });
})()"#
}

#[cfg(test)]
mod tests {
    use super::{
        get_adapters_snapshot, reset_overrides, resolve_adapter_for_host,
        validate_and_save_overrides,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("orca-web-bots-{tag}-{nanos}"));
        fs::create_dir_all(&p).expect("create temp dir");
        p
    }

    #[test]
    fn host_matching_resolves_builtin_and_generic_fallback() {
        let dir = temp_dir("adapters-builtin");
        assert_eq!(resolve_adapter_for_host(&dir, "muse.ai").id, "muse");
        assert_eq!(resolve_adapter_for_host(&dir, "sub.muse.ai").id, "muse");
        assert_eq!(resolve_adapter_for_host(&dir, "app.hark.com").id, "hark");
        assert_eq!(
            resolve_adapter_for_host(&dir, "unknown.example.org").id,
            "generic"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overrides_hot_reload_validate_and_reset() {
        let dir = temp_dir("adapters-override");
        assert!(validate_and_save_overrides(&dir, "{ invalid json").is_err());

        let custom_json = r##"
          [
            {
              "id": "custom_web",
              "name": "Custom Web",
              "hostPatterns": ["example.com", "*.example.com"],
              "composerSelectors": ["[contenteditable=\"true\"]"],
              "preferEnterSubmit": true
            },
            {
              "id": "muse",
              "name": "Muse Custom",
              "hostPatterns": ["muse.ai"],
              "composerSelectors": ["#custom-muse-box"],
              "preferEnterSubmit": true
            }
          ]
        "##;

        let snap = validate_and_save_overrides(&dir, custom_json).expect("save valid overrides");
        assert!(snap.has_overrides);
        assert_eq!(
            resolve_adapter_for_host(&dir, "www.example.com").id,
            "custom_web"
        );
        let muse = resolve_adapter_for_host(&dir, "muse.ai");
        assert_eq!(muse.name, "Muse Custom");
        assert_eq!(muse.composer_selectors, vec!["#custom-muse-box".to_string()]);
        assert!(muse.prefer_enter_submit);
        assert_eq!(
            resolve_adapter_for_host(&dir, "other.example.net").id,
            "generic"
        );

        let reset_snap = reset_overrides(&dir).expect("reset overrides");
        assert!(!reset_snap.has_overrides);
        assert_eq!(
            resolve_adapter_for_host(&dir, "www.example.com").id,
            "generic"
        );
        assert_eq!(resolve_adapter_for_host(&dir, "muse.ai").name, "Muse · Meta");
        assert!(!get_adapters_snapshot(&dir).has_overrides);
        let _ = fs::remove_dir_all(&dir);
    }
}
