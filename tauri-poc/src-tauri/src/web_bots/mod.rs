pub mod cookies;
pub mod external_transport;
pub mod group_orchestrator;
pub mod providers;
pub mod site_adapters;
pub mod storage;
pub mod sync_bundle;
pub mod webview_manager;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use cookies::{
    clear_cookies_via_cdp, export_cookies_via_cdp, export_parsed_cookies_via_cdp,
    inject_cookies_via_cdp, parse_raw_cookies,
};
use external_transport::{normalize_external_agent_input, normalize_proxy_url, test_proxy, ProxyTestResult};
use group_orchestrator::{
    dispatch_group_message, retry_single_group_message, WebBotsRuntimeInner,
};
use providers::{normalize_custom_provider_input, resolve_provider_spec};
use site_adapters::{
    get_adapters_snapshot, reset_overrides, resolve_adapter_for_host, validate_and_save_overrides,
    SiteAdaptersSnapshot,
};
use storage::{
    build_snapshot, load_state, new_uuid_v4, now_ms, AccountKey, AccountRecord, AuthState,
    ExternalAgentKind, GroupChatRecord, GroupMemberRole, GroupSharedSkill, GroupWorkflowMode,
    WebBotsSettings, WebBotsSnapshot,
};
use sync_bundle::{
    decrypt_sync_bundle, encrypt_sync_bundle, merge_sync_payload, ExportSyncBundleResponse,
    ImportSyncBundleResponse, SyncBundlePayload,
};
use webview_manager::{
    apply_timezone_override, navigate_account_webview, probe_account_webview,
    remove_profile_directory, reset_web_bot_chat, WebBotViewportBounds, WebBotWebviewManager,
};

const STATE_FILE_NAME: &str = "web-bots-state.json";

#[derive(Clone)]
pub struct WebBotsState {
    pub inner: Arc<Mutex<WebBotsRuntimeInner>>,
}

impl WebBotsState {
    pub fn new(app: &AppHandle) -> Self {
        let base_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let state_path = base_dir.join(STATE_FILE_NAME);
        let persisted = load_state(&state_path);
        Self {
            inner: Arc::new(Mutex::new(WebBotsRuntimeInner {
                state_path,
                adapter_dir: base_dir,
                persisted,
                webviews: WebBotWebviewManager::default(),
                account_errors: HashMap::new(),
            })),
        }
    }
}

#[tauri::command]
pub async fn poc_web_bots_get_state(
    state: State<'_, WebBotsState>,
) -> Result<WebBotsSnapshot, String> {
    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_select_provider(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
) -> Result<WebBotsSnapshot, String> {
    let mut guard = state.inner.lock().await;
    let spec = resolve_provider_spec(&provider_id, &guard.persisted.custom_providers)
        .ok_or_else(|| format!("未知服务提供商: {provider_id}"))?;
    guard.persisted.selected_provider_id = spec.info.id.clone();

    let matching_acc = guard
        .persisted
        .accounts
        .iter()
        .find(|a| a.provider_id == spec.info.id)
        .cloned();
    guard.persisted.active_account = matching_acc.as_ref().map(AccountRecord::key);

    if let Some(ref acc) = matching_acc {
        let _ = guard
            .webviews
            .ensure_webview(&app, acc, &spec.info.entry_url, true);
    }
    let active = guard.persisted.active_account.clone();
    guard.webviews.apply_viewport(
        &app,
        active.as_ref(),
        WebBotViewportBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            visible: false,
        },
    );
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_add_custom_provider(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    name: String,
    short_name: Option<String>,
    entry_url: String,
    allowed_hosts: Vec<String>,
) -> Result<WebBotsSnapshot, String> {
    let mut guard = state.inner.lock().await;
    let existing_ids: Vec<String> = guard
        .persisted
        .custom_providers
        .iter()
        .map(|p| p.id.clone())
        .chain(["muse".to_string(), "hark".to_string()])
        .collect();
    let record = normalize_custom_provider_input(
        &name,
        short_name.as_deref(),
        &entry_url,
        allowed_hosts,
        &existing_ids,
        now_ms(),
    )?;
    guard.persisted.selected_provider_id = record.id.clone();
    guard.persisted.custom_providers.push(record);
    guard.persisted.active_account = None;
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_remove_custom_provider(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
) -> Result<WebBotsSnapshot, String> {
    let removed_accounts: Vec<AccountKey> = {
        let mut guard = state.inner.lock().await;
        let orig = guard.persisted.custom_providers.len();
        guard
            .persisted
            .custom_providers
            .retain(|p| p.id != provider_id);
        if guard.persisted.custom_providers.len() == orig {
            return Err("未找到要删除的自定义站点".to_string());
        }
        let mut removed = Vec::new();
        guard.persisted.accounts.retain(|a| {
            if a.provider_id == provider_id {
                removed.push(a.key());
                false
            } else {
                true
            }
        });
        for key in &removed {
            guard.webviews.close_webview(&app, key);
            guard.account_errors.remove(&key.composite_key());
        }
        if guard.persisted.selected_provider_id == provider_id {
            guard.persisted.selected_provider_id = "muse".to_string();
        }
        if guard
            .persisted
            .active_account
            .as_ref()
            .is_some_and(|k| k.provider_id == provider_id)
        {
            guard.persisted.active_account = guard
                .persisted
                .accounts
                .iter()
                .find(|a| a.provider_id == guard.persisted.selected_provider_id)
                .map(AccountRecord::key);
        }
        guard.save_and_emit(&app);
        removed
    };

    for key in removed_accounts {
        remove_profile_directory(&app, &key).await;
    }

    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_add_account(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    alias: String,
    proxy_url: Option<String>,
    timezone: Option<String>,
    raw_cookies: Option<String>,
) -> Result<WebBotsSnapshot, String> {
    let clean_proxy = normalize_proxy_url(proxy_url.as_deref())?;
    let clean_tz = timezone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let (account, spec, parsed_cookies) = {
        let mut guard = state.inner.lock().await;
        let spec = resolve_provider_spec(&provider_id, &guard.persisted.custom_providers)
            .ok_or_else(|| format!("未知服务提供商: {provider_id}"))?;
        let count_for_provider = guard
            .persisted
            .accounts
            .iter()
            .filter(|a| a.provider_id == spec.info.id)
            .count();
        let clean_alias = alias.trim();
        let (final_alias, auto_alias) = if clean_alias.is_empty() {
            (
                format!("{} #{}", spec.info.short_name, count_for_provider + 1),
                true,
            )
        } else {
            (clean_alias.to_string(), false)
        };

        let parsed_cookies = if let Some(ref raw) = raw_cookies {
            if raw.trim().is_empty() {
                None
            } else {
                let default_domain = spec
                    .info
                    .allowed_hosts
                    .first()
                    .map(String::as_str)
                    .unwrap_or("localhost");
                Some(parse_raw_cookies(raw, default_domain)?)
            }
        } else {
            None
        };

        let account = AccountRecord {
            provider_id: spec.info.id.clone(),
            uuid: new_uuid_v4(),
            alias: final_alias,
            auto_alias,
            email: None,
            created_at_ms: now_ms(),
            proxy_url: clean_proxy,
            timezone: clean_tz,
            avatar_url: None,
            quota_text: None,
            quota_percent: None,
            quota_detail: None,
            auth_state: if parsed_cookies.is_some() {
                AuthState::Authenticated
            } else {
                AuthState::Unknown
            },
            cookie_expires_at_ms: None,
            cookie_session_only: false,
            cooldown_until_ms: None,
            last_used_at_ms: None,
        };

        if guard.persisted.settings.isolate_same_proxy_keep_alive {
            let inner = &mut *guard;
            inner
                .webviews
                .close_same_proxy_siblings(&app, &account, &inner.persisted.accounts);
        }

        guard.persisted.selected_provider_id = spec.info.id.clone();
        guard.persisted.active_account = Some(account.key());
        guard.persisted.accounts.push(account.clone());
        guard.save_and_emit(&app);
        (account, spec, parsed_cookies)
    };

    if let Some(cookies) = parsed_cookies {
        let webview = {
            let mut guard = state.inner.lock().await;
            let (wv, _) = guard.webviews.ensure_webview(
                &app,
                &account,
                "about:blank",
                false,
            )?;
            wv
        };
        if let Err(err) = inject_cookies_via_cdp(&webview, &cookies).await {
            let mut guard = state.inner.lock().await;
            guard.account_errors.insert(account.key().composite_key(), err.clone());
            guard.emit_snapshot(&app);
            return Err(err);
        }
        if let Ok(entry) = url::Url::parse(&spec.info.entry_url) {
            let _ = webview.navigate(entry);
        }
    } else {
        let mut guard = state.inner.lock().await;
        let _ = guard
            .webviews
            .ensure_webview(&app, &account, &spec.info.entry_url, false);
    }

    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_update_account(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
    alias: String,
    proxy_url: Option<String>,
    timezone: Option<String>,
) -> Result<WebBotsSnapshot, String> {
    let clean_proxy = normalize_proxy_url(proxy_url.as_deref())?;
    let clean_tz = timezone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let clean_alias = alias.trim().to_string();
    if clean_alias.is_empty() {
        return Err("账号别名不能为空".to_string());
    }

    let mut guard = state.inner.lock().await;
    let key = AccountKey { provider_id, uuid };
    let idx = guard
        .persisted
        .accounts
        .iter()
        .position(|a| a.key() == key)
        .ok_or_else(|| "未找到目标账号".to_string())?;
    let proxy_changed = guard.persisted.accounts[idx].proxy_url != clean_proxy;
    guard.persisted.accounts[idx].alias = clean_alias;
    guard.persisted.accounts[idx].auto_alias = false;
    guard.persisted.accounts[idx].proxy_url = clean_proxy;
    guard.persisted.accounts[idx].timezone = clean_tz;

    if proxy_changed {
        // Recreate WebView on next switch so WebView2 applies the new proxy_url.
        guard.webviews.close_webview(&app, &key);
    }
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_remove_account(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
) -> Result<WebBotsSnapshot, String> {
    let key = AccountKey { provider_id, uuid };
    {
        let mut guard = state.inner.lock().await;
        let orig = guard.persisted.accounts.len();
        guard.persisted.accounts.retain(|a| a.key() != key);
        if guard.persisted.accounts.len() == orig {
            return Err("未找到要删除的账号".to_string());
        }
        guard.webviews.close_webview(&app, &key);
        guard.account_errors.remove(&key.composite_key());
        for group in &mut guard.persisted.group_chats {
            group.members.retain(|m| *m != key);
            group.member_roles.retain(|r| r.member != key);
            group.thread_bindings.retain(|b| b.member != key);
        }
        if guard.persisted.active_account.as_ref() == Some(&key) {
            guard.persisted.active_account = guard
                .persisted
                .accounts
                .iter()
                .find(|a| a.provider_id == guard.persisted.selected_provider_id)
                .map(AccountRecord::key);
        }
        guard.save_and_emit(&app);
    }

    remove_profile_directory(&app, &key).await;

    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_reorder_accounts(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    ordered_uuids: Vec<String>,
) -> Result<WebBotsSnapshot, String> {
    let mut guard = state.inner.lock().await;
    let mut provider_accounts: Vec<AccountRecord> = Vec::new();
    let mut other_accounts: Vec<AccountRecord> = Vec::new();
    for acc in guard.persisted.accounts.drain(..) {
        if acc.provider_id == provider_id {
            provider_accounts.push(acc);
        } else {
            other_accounts.push(acc);
        }
    }
    let mut reordered = Vec::with_capacity(provider_accounts.len());
    for uid in ordered_uuids {
        if let Some(pos) = provider_accounts.iter().position(|a| a.uuid == uid) {
            reordered.push(provider_accounts.remove(pos));
        }
    }
    reordered.extend(provider_accounts);
    other_accounts.extend(reordered);
    guard.persisted.accounts = other_accounts;
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_switch_account(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
) -> Result<WebBotsSnapshot, String> {
    let key = AccountKey { provider_id, uuid };
    let (account, entry_url) = {
        let mut guard = state.inner.lock().await;
        let account = guard
            .persisted
            .accounts
            .iter()
            .find(|a| a.key() == key)
            .cloned()
            .ok_or_else(|| "未找到目标账号".to_string())?;
        let spec = resolve_provider_spec(&account.provider_id, &guard.persisted.custom_providers)
            .ok_or_else(|| format!("未知服务提供商: {}", account.provider_id))?;

        if guard.persisted.settings.isolate_same_proxy_keep_alive {
            let inner = &mut *guard;
            inner
                .webviews
                .close_same_proxy_siblings(&app, &account, &inner.persisted.accounts);
        }

        let _ = guard
            .webviews
            .ensure_webview(&app, &account, &spec.info.entry_url, false)?;
        guard.persisted.selected_provider_id = account.provider_id.clone();
        guard.persisted.active_account = Some(key.clone());
        guard.account_errors.remove(&key.composite_key());
        guard.save_and_emit(&app);
        (account, spec.info.entry_url)
    };
    let _ = entry_url;

    // Best-effort probe of login state / email / timezone without blocking switch.
    let wv_opt = {
        let guard = state.inner.lock().await;
        guard.webviews.get_webview(&app, &account.key())
    };
    if let Some(wv) = wv_opt {
        let _ = apply_timezone_override(&wv, account.timezone.as_deref()).await;
        if let Ok(probe) = probe_account_webview(&wv).await {
            let mut guard = state.inner.lock().await;
            if let Some(acc) = guard
                .persisted
                .accounts
                .iter_mut()
                .find(|a| a.key() == key)
            {
                if probe.email.is_some() {
                    acc.email = probe.email.clone();
                    if acc.auto_alias {
                        if let Some(ref e) = probe.email {
                            acc.alias = e.clone();
                        }
                    }
                }
                if probe.quota_text.is_some() {
                    acc.quota_text = probe.quota_text;
                }
                if probe.quota_percent.is_some() {
                    acc.quota_percent = probe.quota_percent;
                }
                if probe.authenticated {
                    acc.auth_state = AuthState::Authenticated;
                }
            }
            guard.save_and_emit(&app);
        }
    }

    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_reload_account(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
) -> Result<WebBotsSnapshot, String> {
    let key = AccountKey { provider_id, uuid };
    let wv = {
        let mut guard = state.inner.lock().await;
        let account = guard
            .persisted
            .accounts
            .iter()
            .find(|a| a.key() == key)
            .cloned()
            .ok_or_else(|| "未找到目标账号".to_string())?;
        let spec = resolve_provider_spec(&account.provider_id, &guard.persisted.custom_providers)
            .ok_or_else(|| format!("未知服务提供商: {}", account.provider_id))?;
        let (wv, created) =
            guard
                .webviews
                .ensure_webview(&app, &account, &spec.info.entry_url, false)?;
        if !created {
            let _ = wv.reload();
        }
        wv
    };
    let _ = wv;

    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_clear_account_data(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
) -> Result<WebBotsSnapshot, String> {
    let key = AccountKey { provider_id, uuid };
    let wv_opt = {
        let guard = state.inner.lock().await;
        guard.webviews.get_webview(&app, &key)
    };
    if let Some(wv) = wv_opt {
        let _ = clear_cookies_via_cdp(&wv).await;
    }
    {
        let mut guard = state.inner.lock().await;
        guard.webviews.close_webview(&app, &key);
        if let Some(acc) = guard
            .persisted
            .accounts
            .iter_mut()
            .find(|a| a.key() == key)
        {
            acc.auth_state = AuthState::LoggedOut;
            acc.cookie_expires_at_ms = None;
            acc.cookie_session_only = false;
        }
        guard.save_and_emit(&app);
    }
    remove_profile_directory(&app, &key).await;

    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_set_viewport(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    bounds: WebBotViewportBounds,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    let active = guard.persisted.active_account.clone();
    if bounds.visible {
        if let Some(ref key) = active {
            if guard.webviews.get_webview(&app, key).is_none() {
                if let Some(acc) = guard
                    .persisted
                    .accounts
                    .iter()
                    .find(|a| a.key() == *key)
                    .cloned()
                {
                    if let Some(spec) =
                        resolve_provider_spec(&acc.provider_id, &guard.persisted.custom_providers)
                    {
                        let _ =
                            guard
                                .webviews
                                .ensure_webview(&app, &acc, &spec.info.entry_url, true);
                    }
                }
            }
        }
    }
    if !bounds.visible {
        guard.webviews.hide_all(&app);
    }
    guard.webviews.apply_viewport(&app, active.as_ref(), bounds);
    Ok(())
}

#[tauri::command]
pub async fn poc_web_bots_import_cookies(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
    raw_cookies: String,
) -> Result<WebBotsSnapshot, String> {
    let key = AccountKey { provider_id, uuid };
    let (account, spec, cookies) = {
        let guard = state.inner.lock().await;
        let account = guard
            .persisted
            .accounts
            .iter()
            .find(|a| a.key() == key)
            .cloned()
            .ok_or_else(|| "未找到目标账号".to_string())?;
        let spec = resolve_provider_spec(&account.provider_id, &guard.persisted.custom_providers)
            .ok_or_else(|| format!("未知服务提供商: {}", account.provider_id))?;
        let default_domain = spec
            .info
            .allowed_hosts
            .first()
            .map(String::as_str)
            .unwrap_or("localhost");
        let cookies = parse_raw_cookies(&raw_cookies, default_domain)?;
        (account, spec, cookies)
    };

    let webview = {
        let mut guard = state.inner.lock().await;
        let (wv, _) = guard
            .webviews
            .ensure_webview(&app, &account, "about:blank", false)?;
        wv
    };
    inject_cookies_via_cdp(&webview, &cookies).await?;
    if let Ok(entry) = url::Url::parse(&spec.info.entry_url) {
        let _ = webview.navigate(entry);
    }

    let mut guard = state.inner.lock().await;
    if let Some(acc) = guard
        .persisted
        .accounts
        .iter_mut()
        .find(|a| a.key() == key)
    {
        acc.auth_state = AuthState::Authenticated;
    }
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_export_cookies(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
) -> Result<String, String> {
    let key = AccountKey { provider_id, uuid };
    let (webview, allowed_hosts) = {
        let mut guard = state.inner.lock().await;
        let account = guard
            .persisted
            .accounts
            .iter()
            .find(|a| a.key() == key)
            .cloned()
            .ok_or_else(|| "未找到目标账号".to_string())?;
        let spec = resolve_provider_spec(&account.provider_id, &guard.persisted.custom_providers)
            .ok_or_else(|| format!("未知服务提供商: {}", account.provider_id))?;
        let (wv, _) =
            guard
                .webviews
                .ensure_webview(&app, &account, &spec.info.entry_url, false)?;
        (wv, spec.info.allowed_hosts)
    };
    let exported = export_cookies_via_cdp(&webview, &allowed_hosts).await?;

    let mut guard = state.inner.lock().await;
    if let Some(acc) = guard
        .persisted
        .accounts
        .iter_mut()
        .find(|a| a.key() == key)
    {
        acc.cookie_expires_at_ms = exported.expires_at_ms;
        acc.cookie_session_only = exported.session_only;
    }
    guard.save_and_emit(&app);
    Ok(exported.json)
}

#[tauri::command]
pub async fn poc_web_bots_test_proxy(
    state: State<'_, WebBotsState>,
    provider_id: String,
    proxy_url: Option<String>,
) -> Result<ProxyTestResult, String> {
    let entry_url = {
        let guard = state.inner.lock().await;
        resolve_provider_spec(&provider_id, &guard.persisted.custom_providers)
            .map(|s| s.info.entry_url)
            .unwrap_or_else(|| "https://muse.ai/".to_string())
    };
    Ok(test_proxy(&entry_url, proxy_url.as_deref()).await)
}

#[tauri::command]
pub async fn poc_web_bots_update_settings(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    settings: WebBotsSettings,
) -> Result<WebBotsSnapshot, String> {
    let mut guard = state.inner.lock().await;
    guard.persisted.settings = WebBotsSettings {
        isolate_same_proxy_keep_alive: settings.isolate_same_proxy_keep_alive,
        silent_sync_interval_mins: settings.silent_sync_interval_mins.min(120),
    };
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_upsert_external_agent(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    id: Option<String>,
    kind: ExternalAgentKind,
    name: String,
    base_url: String,
    api_key: String,
    model: String,
    command: String,
    args: Vec<String>,
    workdir: Option<String>,
) -> Result<WebBotsSnapshot, String> {
    let mut guard = state.inner.lock().await;
    let existing_created = id.as_deref().and_then(|target_id| {
        guard
            .persisted
            .external_agents
            .iter()
            .find(|a| a.id == target_id)
            .map(|a| a.created_at_ms)
    });
    let record = normalize_external_agent_input(
        id.as_deref(),
        kind,
        &name,
        &base_url,
        &api_key,
        &model,
        &command,
        args,
        workdir.as_deref(),
        existing_created,
    )?;
    if let Some(existing) = guard
        .persisted
        .external_agents
        .iter_mut()
        .find(|a| a.id == record.id)
    {
        *existing = record;
    } else {
        guard.persisted.external_agents.push(record);
    }
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_delete_external_agent(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    id: String,
) -> Result<WebBotsSnapshot, String> {
    let mut guard = state.inner.lock().await;
    let orig = guard.persisted.external_agents.len();
    guard.persisted.external_agents.retain(|a| a.id != id);
    if guard.persisted.external_agents.len() == orig {
        return Err("未找到外部 Agent".to_string());
    }
    for group in &mut guard.persisted.group_chats {
        group.members.retain(|m| m.uuid != id);
        group.member_roles.retain(|r| r.member.uuid != id);
    }
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_get_site_adapters(
    state: State<'_, WebBotsState>,
) -> Result<SiteAdaptersSnapshot, String> {
    let guard = state.inner.lock().await;
    Ok(get_adapters_snapshot(&guard.adapter_dir))
}

#[tauri::command]
pub async fn poc_web_bots_save_site_adapter_overrides(
    state: State<'_, WebBotsState>,
    raw_json: String,
) -> Result<SiteAdaptersSnapshot, String> {
    let guard = state.inner.lock().await;
    validate_and_save_overrides(&guard.adapter_dir, &raw_json)
}

#[tauri::command]
pub async fn poc_web_bots_reset_site_adapter_overrides(
    state: State<'_, WebBotsState>,
) -> Result<SiteAdaptersSnapshot, String> {
    let guard = state.inner.lock().await;
    reset_overrides(&guard.adapter_dir)
}

#[tauri::command]
pub async fn poc_web_bots_create_group(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    name: String,
    members: Vec<AccountKey>,
    workflow_mode: GroupWorkflowMode,
    max_relay_hops: Option<u32>,
    shared_context: Option<String>,
    shared_skills: Option<Vec<GroupSharedSkill>>,
    member_roles: Option<Vec<GroupMemberRole>>,
) -> Result<WebBotsSnapshot, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() {
        return Err("群聊名称不能为空".to_string());
    }
    if members.is_empty() {
        return Err("请至少选择一个群聊成员".to_string());
    }
    let id = new_uuid_v4();
    let record = GroupChatRecord {
        id: id.clone(),
        name: clean_name.to_string(),
        members,
        created_at_ms: now_ms(),
        messages: Vec::new(),
        shared_context: shared_context.unwrap_or_default(),
        shared_skills: shared_skills.unwrap_or_default(),
        member_roles: member_roles.unwrap_or_default(),
        workflow_mode,
        max_relay_hops: max_relay_hops.unwrap_or(3).clamp(1, 6),
        thread_bindings: Vec::new(),
    };
    let mut guard = state.inner.lock().await;
    guard.persisted.active_group_id = Some(id);
    guard.persisted.group_chats.push(record);
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_update_group(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    group_id: String,
    name: String,
    members: Vec<AccountKey>,
    workflow_mode: GroupWorkflowMode,
    max_relay_hops: Option<u32>,
    shared_context: Option<String>,
    shared_skills: Option<Vec<GroupSharedSkill>>,
    member_roles: Option<Vec<GroupMemberRole>>,
) -> Result<WebBotsSnapshot, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() {
        return Err("群聊名称不能为空".to_string());
    }
    if members.is_empty() {
        return Err("请至少选择一个群聊成员".to_string());
    }
    let mut guard = state.inner.lock().await;
    let group = guard
        .persisted
        .group_chats
        .iter_mut()
        .find(|g| g.id == group_id)
        .ok_or_else(|| "未找到目标群聊".to_string())?;
    group.name = clean_name.to_string();
    group.members = members;
    group.workflow_mode = workflow_mode;
    if let Some(hops) = max_relay_hops {
        group.max_relay_hops = hops.clamp(1, 6);
    }
    if let Some(ctx) = shared_context {
        group.shared_context = ctx;
    }
    if let Some(skills) = shared_skills {
        group.shared_skills = skills;
    }
    if let Some(roles) = member_roles {
        group.member_roles = roles;
    }
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_delete_group(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    group_id: String,
) -> Result<WebBotsSnapshot, String> {
    let mut guard = state.inner.lock().await;
    let orig = guard.persisted.group_chats.len();
    guard.persisted.group_chats.retain(|g| g.id != group_id);
    if guard.persisted.group_chats.len() == orig {
        return Err("未找到要删除的群聊".to_string());
    }
    if guard.persisted.active_group_id.as_deref() == Some(group_id.as_str()) {
        guard.persisted.active_group_id =
            guard.persisted.group_chats.first().map(|g| g.id.clone());
    }
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_send_group_message(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    group_id: String,
    content: String,
) -> Result<WebBotsSnapshot, String> {
    dispatch_group_message(app, Arc::clone(&state.inner), group_id, content).await?;
    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_clear_group_messages(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    group_id: String,
) -> Result<WebBotsSnapshot, String> {
    let mut guard = state.inner.lock().await;
    let group = guard
        .persisted
        .group_chats
        .iter_mut()
        .find(|g| g.id == group_id)
        .ok_or_else(|| "未找到目标群聊".to_string())?;
    group.messages.clear();
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_new_group_topic(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    group_id: String,
) -> Result<WebBotsSnapshot, String> {
    let targets_to_reset = {
        let mut guard = state.inner.lock().await;
        let group = guard
            .persisted
            .group_chats
            .iter_mut()
            .find(|g| g.id == group_id)
            .ok_or_else(|| "未找到目标群聊".to_string())?;
        group.messages.clear();
        group.thread_bindings.clear();
        let members = group.members.clone();
        let adapter_dir = guard.adapter_dir.clone();
        let mut list = Vec::new();
        for key in members {
            if let Some(wv) = guard.webviews.get_webview(&app, &key) {
                if let Some(spec) =
                    resolve_provider_spec(&key.provider_id, &guard.persisted.custom_providers)
                {
                    let host = url::Url::parse(&spec.info.entry_url)
                        .ok()
                        .and_then(|u| u.host_str().map(ToOwned::to_owned))
                        .unwrap_or_default();
                    let adapter = resolve_adapter_for_host(&adapter_dir, &host);
                    list.push((wv, adapter, spec.info.entry_url));
                }
            }
        }
        guard.save_and_emit(&app);
        list
    };

    for (wv, adapter, fallback_url) in targets_to_reset {
        let _ = reset_web_bot_chat(&wv, &adapter, &fallback_url).await;
    }

    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_retry_group_message(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    group_id: String,
    message_id: String,
) -> Result<WebBotsSnapshot, String> {
    retry_single_group_message(app, Arc::clone(&state.inner), group_id, message_id).await?;
    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

async fn sync_single_account(
    app: &AppHandle,
    inner: &Arc<Mutex<WebBotsRuntimeInner>>,
    key: &AccountKey,
    ensure_if_cold: bool,
) -> Result<(), String> {
    let (wv, account, allowed_hosts) = {
        let mut guard = inner.lock().await;
        let account = guard
            .persisted
            .accounts
            .iter()
            .find(|a| a.key() == *key)
            .cloned()
            .ok_or_else(|| "未找到目标账号".to_string())?;
        let spec = resolve_provider_spec(&account.provider_id, &guard.persisted.custom_providers)
            .ok_or_else(|| format!("未知服务提供商: {}", account.provider_id))?;
        let wv = if ensure_if_cold {
            let (wv, _) =
                guard
                    .webviews
                    .ensure_webview(app, &account, &spec.info.entry_url, false)?;
            wv
        } else {
            let Some(wv) = guard.webviews.get_webview(app, key) else {
                return Ok(());
            };
            wv
        };
        (wv, account, spec.info.allowed_hosts)
    };

    let _ = apply_timezone_override(&wv, account.timezone.as_deref()).await;
    let probe = probe_account_webview(&wv).await;
    let cookie_info = export_parsed_cookies_via_cdp(&wv, &allowed_hosts).await;

    let mut guard = inner.lock().await;
    if let Some(acc) = guard
        .persisted
        .accounts
        .iter_mut()
        .find(|a| a.key() == *key)
    {
        if let Ok(ref p) = probe {
            if p.email.is_some() {
                acc.email = p.email.clone();
                if acc.auto_alias {
                    if let Some(ref e) = p.email {
                        acc.alias = e.clone();
                    }
                }
            }
            if p.quota_text.is_some() {
                acc.quota_text = p.quota_text.clone();
            }
            if p.quota_percent.is_some() {
                acc.quota_percent = p.quota_percent;
            }
            acc.auth_state = if p.authenticated {
                AuthState::Authenticated
            } else if acc.auth_state == AuthState::Authenticated {
                AuthState::LoggedOut
            } else {
                acc.auth_state
            };
        }
        if let Ok((_, exp_ms, session_only)) = cookie_info {
            acc.cookie_expires_at_ms = exp_ms;
            acc.cookie_session_only = session_only;
        }
    }
    guard.save_and_emit(app);
    Ok(())
}

pub fn start_background_sync_loop(app: AppHandle, state: WebBotsState) {
    tauri::async_runtime::spawn(async move {
        let mut last_run = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let (interval_mins, warm_keys) = {
                let guard = state.inner.lock().await;
                (
                    guard.persisted.settings.silent_sync_interval_mins,
                    guard.webviews.warm_accounts(),
                )
            };
            if interval_mins == 0 || warm_keys.is_empty() {
                continue;
            }
            if last_run.elapsed() < Duration::from_secs((interval_mins as u64) * 60) {
                continue;
            }
            last_run = Instant::now();
            for (idx, key) in warm_keys.iter().enumerate() {
                if idx > 0 {
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                }
                let _ = sync_single_account(&app, &state.inner, key, false).await;
            }
        }
    });
}

#[tauri::command]
pub async fn poc_web_bots_sync_account(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
) -> Result<WebBotsSnapshot, String> {
    let key = AccountKey { provider_id, uuid };
    sync_single_account(&app, &state.inner, &key, true).await?;
    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_sync_all(
    app: AppHandle,
    state: State<'_, WebBotsState>,
) -> Result<WebBotsSnapshot, String> {
    let (keys, ensure_cold) = {
        let guard = state.inner.lock().await;
        if guard.persisted.settings.isolate_same_proxy_keep_alive {
            (guard.webviews.warm_accounts(), false)
        } else {
            (
                guard.persisted.accounts.iter().map(AccountRecord::key).collect(),
                true,
            )
        }
    };

    for (idx, key) in keys.iter().enumerate() {
        if idx > 0 {
            tokio::time::sleep(Duration::from_millis(1200)).await;
        }
        let _ = sync_single_account(&app, &state.inner, key, ensure_cold).await;
    }

    let guard = state.inner.lock().await;
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_navigate(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    provider_id: String,
    uuid: String,
    action: String,
    url: Option<String>,
) -> Result<Option<String>, String> {
    let key = AccountKey { provider_id, uuid };
    let (webview, home_url) = {
        let mut guard = state.inner.lock().await;
        let account = guard
            .persisted
            .accounts
            .iter()
            .find(|a| a.key() == key)
            .cloned()
            .ok_or_else(|| "未找到目标账号".to_string())?;
        let spec = resolve_provider_spec(&account.provider_id, &guard.persisted.custom_providers)
            .ok_or_else(|| format!("未知服务提供商: {}", account.provider_id))?;
        let (wv, _) =
            guard
                .webviews
                .ensure_webview(&app, &account, &spec.info.entry_url, false)?;
        (wv, spec.info.entry_url)
    };
    navigate_account_webview(&webview, &action, url.as_deref(), &home_url).await
}

#[tauri::command]
pub async fn poc_web_bots_append_group_context(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    group_id: String,
    snippet: String,
) -> Result<WebBotsSnapshot, String> {
    let clean = snippet.trim();
    if clean.is_empty() {
        return Err("沉淀内容不能为空".to_string());
    }
    let mut guard = state.inner.lock().await;
    let group = guard
        .persisted
        .group_chats
        .iter_mut()
        .find(|g| g.id == group_id)
        .ok_or_else(|| "未找到目标群聊".to_string())?;
    if group.shared_context.trim().is_empty() {
        group.shared_context = clean.to_string();
    } else {
        group.shared_context = format!("{}\n\n{}", group.shared_context.trim_end(), clean);
    }
    guard.save_and_emit(&app);
    Ok(build_snapshot(
        &guard.persisted,
        guard.webviews.warm_accounts(),
        &guard.account_errors,
    ))
}

#[tauri::command]
pub async fn poc_web_bots_export_sync_bundle(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    passphrase: String,
    include_cookies: bool,
) -> Result<ExportSyncBundleResponse, String> {
    let (accounts, custom_providers, group_chats, external_agents, targets) = {
        let guard = state.inner.lock().await;
        let mut cookie_targets = Vec::new();
        if include_cookies {
            for acc in &guard.persisted.accounts {
                if let Some(wv) = guard.webviews.get_webview(&app, &acc.key()) {
                    if let Some(spec) = resolve_provider_spec(
                        &acc.provider_id,
                        &guard.persisted.custom_providers,
                    ) {
                        cookie_targets.push((acc.key().composite_key(), wv, spec.info.allowed_hosts));
                    }
                }
            }
        }
        (
            guard.persisted.accounts.clone(),
            guard.persisted.custom_providers.clone(),
            guard.persisted.group_chats.clone(),
            guard.persisted.external_agents.clone(),
            cookie_targets,
        )
    };

    let mut account_cookies = BTreeMap::new();
    for (composite, wv, allowed_hosts) in targets {
        if let Ok((cookies, _, _)) = export_parsed_cookies_via_cdp(&wv, &allowed_hosts).await {
            if !cookies.is_empty() {
                account_cookies.insert(composite, cookies);
            }
        }
    }

    let exported_at_ms = now_ms();
    let account_count = accounts.len();
    let cookie_account_count = account_cookies.len();
    let payload = SyncBundlePayload {
        schema_version: 1,
        exported_at_ms,
        source_platform: std::env::consts::OS.to_string(),
        accounts,
        custom_providers,
        account_cookies,
        group_chats,
        external_agents,
    };
    let bundle_json = encrypt_sync_bundle(&payload, &passphrase)?;
    Ok(ExportSyncBundleResponse {
        filename: format!("orca-web-bots-{exported_at_ms}.maam"),
        bundle_json,
        account_count,
        cookie_account_count,
    })
}

#[tauri::command]
pub async fn poc_web_bots_import_sync_bundle(
    app: AppHandle,
    state: State<'_, WebBotsState>,
    bundle_json: String,
    passphrase: String,
) -> Result<ImportSyncBundleResponse, String> {
    let payload = decrypt_sync_bundle(&bundle_json, &passphrase)?;

    let (mut summary, cookie_jobs) = {
        let mut guard = state.inner.lock().await;
        let summary = merge_sync_payload(&mut guard.persisted, &payload);

        let mut jobs = Vec::new();
        for (composite, cookies) in &payload.account_cookies {
            if cookies.is_empty() {
                continue;
            }
            let Some((provider_id, uuid)) = composite.split_once(':') else {
                continue;
            };
            let key = AccountKey {
                provider_id: provider_id.to_string(),
                uuid: uuid.to_string(),
            };
            if let Some(acc) = guard.persisted.accounts.iter().find(|a| a.key() == key).cloned() {
                if let Some(spec) =
                    resolve_provider_spec(&acc.provider_id, &guard.persisted.custom_providers)
                {
                    if let Ok((wv, _)) =
                        guard.webviews.ensure_webview(&app, &acc, "about:blank", false)
                    {
                        jobs.push((key, wv, spec.info.entry_url, cookies.clone()));
                    }
                }
            }
        }
        guard.save_and_emit(&app);
        (summary, jobs)
    };

    let total_cookie_accounts = payload.account_cookies.len();
    let mut imported_cookie_accounts = 0usize;
    for (_key, wv, entry_url, cookies) in cookie_jobs {
        if inject_cookies_via_cdp(&wv, &cookies).await.is_ok() {
            imported_cookie_accounts += 1;
            if let Ok(parsed) = url::Url::parse(&entry_url) {
                let _ = wv.navigate(parsed);
            }
        }
    }
    summary.imported_cookie_accounts = imported_cookie_accounts;
    summary.skipped_cookie_accounts = total_cookie_accounts.saturating_sub(imported_cookie_accounts);

    let guard = state.inner.lock().await;
    guard.emit_snapshot(&app);
    Ok(ImportSyncBundleResponse {
        snapshot: build_snapshot(
            &guard.persisted,
            guard.webviews.warm_accounts(),
            &guard.account_errors,
        ),
        summary,
    })
}
