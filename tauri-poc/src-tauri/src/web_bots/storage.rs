use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::web_bots::providers::{all_provider_infos, CustomWebProviderRecord, ProviderInfo};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct AccountKey {
    pub provider_id: String,
    pub uuid: String,
}

impl AccountKey {
    pub fn composite_key(&self) -> String {
        format!("{}:{}", self.provider_id, self.uuid)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    #[default]
    Unknown,
    Authenticated,
    LoggedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaDetail {
    pub plan_label: String,
    pub plan_value: String,
    pub plan_subtext: Option<String>,
    pub plan_used_percent: Option<f64>,
    pub extra_label: Option<String>,
    pub extra_value: Option<String>,
    pub extra_subtext: Option<String>,
    pub extra_used_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub provider_id: String,
    pub uuid: String,
    pub alias: String,
    #[serde(default)]
    pub auto_alias: bool,
    #[serde(default)]
    pub email: Option<String>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub quota_text: Option<String>,
    #[serde(default)]
    pub quota_percent: Option<f64>,
    #[serde(default)]
    pub quota_detail: Option<QuotaDetail>,
    #[serde(default)]
    pub auth_state: AuthState,
    #[serde(default)]
    pub cookie_expires_at_ms: Option<u64>,
    #[serde(default)]
    pub cookie_session_only: bool,
    #[serde(default)]
    pub cooldown_until_ms: Option<u64>,
    #[serde(default)]
    pub last_used_at_ms: Option<u64>,
}

impl AccountRecord {
    pub fn key(&self) -> AccountKey {
        AccountKey {
            provider_id: self.provider_id.clone(),
            uuid: self.uuid.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAgentKind {
    OpenaiApi,
    LocalCli,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentRecord {
    pub id: String,
    pub kind: ExternalAgentKind,
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub workdir: Option<String>,
    pub created_at_ms: u64,
}

impl ExternalAgentRecord {
    pub fn provider_id(&self) -> &'static str {
        match self.kind {
            ExternalAgentKind::OpenaiApi => "api",
            ExternalAgentKind::LocalCli => "cli",
        }
    }

    pub fn account_key(&self) -> AccountKey {
        AccountKey {
            provider_id: self.provider_id().to_string(),
            uuid: self.id.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GroupWorkflowMode {
    #[default]
    Parallel,
    Review,
    A2aRelay,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GroupReplyStatus {
    Queued,
    Sending,
    Streaming,
    Done,
    NeedsAuth,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSharedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberRole {
    pub member: AccountKey,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupThreadBinding {
    pub member: AccountKey,
    pub thread_url: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupChatMessage {
    pub id: String,
    pub role: String,
    pub sender: Option<AccountKey>,
    pub sender_name: String,
    pub content: String,
    pub created_at_ms: u64,
    pub status: GroupReplyStatus,
    #[serde(default)]
    pub targets: Vec<AccountKey>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub stage_label: Option<String>,
    #[serde(default)]
    pub hop_depth: Option<u32>,
    #[serde(default)]
    pub auto_routed_channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupChatRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub members: Vec<AccountKey>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub messages: Vec<GroupChatMessage>,
    #[serde(default)]
    pub shared_context: String,
    #[serde(default)]
    pub shared_skills: Vec<GroupSharedSkill>,
    #[serde(default)]
    pub member_roles: Vec<GroupMemberRole>,
    #[serde(default)]
    pub workflow_mode: GroupWorkflowMode,
    #[serde(default = "default_max_relay_hops")]
    pub max_relay_hops: u32,
    #[serde(default)]
    pub thread_bindings: Vec<GroupThreadBinding>,
}

fn default_max_relay_hops() -> u32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebBotsSettings {
    #[serde(default = "default_true")]
    pub isolate_same_proxy_keep_alive: bool,
    #[serde(default = "default_sync_interval")]
    pub silent_sync_interval_mins: u32,
}

fn default_true() -> bool {
    true
}

fn default_sync_interval() -> u32 {
    15
}

impl Default for WebBotsSettings {
    fn default() -> Self {
        Self {
            isolate_same_proxy_keep_alive: true,
            silent_sync_interval_mins: 15,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebBotsPersistedState {
    #[serde(default = "default_selected_provider")]
    pub selected_provider_id: String,
    #[serde(default)]
    pub active_account: Option<AccountKey>,
    #[serde(default)]
    pub custom_providers: Vec<CustomWebProviderRecord>,
    #[serde(default)]
    pub accounts: Vec<AccountRecord>,
    #[serde(default)]
    pub settings: WebBotsSettings,
    #[serde(default)]
    pub group_chats: Vec<GroupChatRecord>,
    #[serde(default)]
    pub active_group_id: Option<String>,
    #[serde(default)]
    pub external_agents: Vec<ExternalAgentRecord>,
}

fn default_selected_provider() -> String {
    "muse".to_string()
}

impl Default for WebBotsPersistedState {
    fn default() -> Self {
        Self {
            selected_provider_id: default_selected_provider(),
            active_account: None,
            custom_providers: Vec::new(),
            accounts: Vec::new(),
            settings: WebBotsSettings::default(),
            group_chats: Vec::new(),
            active_group_id: None,
            external_agents: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPageError {
    pub provider_id: String,
    pub uuid: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebBotsSnapshot {
    pub providers: Vec<ProviderInfo>,
    pub custom_providers: Vec<CustomWebProviderRecord>,
    pub accounts: Vec<AccountRecord>,
    pub selected_provider_id: String,
    pub active_account: Option<AccountKey>,
    pub warm_accounts: Vec<AccountKey>,
    pub settings: WebBotsSettings,
    pub group_chats: Vec<GroupChatRecord>,
    pub active_group_id: Option<String>,
    pub external_agents: Vec<ExternalAgentRecord>,
    pub account_errors: Vec<AccountPageError>,
}

pub fn build_snapshot(
    state: &WebBotsPersistedState,
    warm_accounts: Vec<AccountKey>,
    account_errors: &HashMap<String, String>,
) -> WebBotsSnapshot {
    let errors = state
        .accounts
        .iter()
        .filter_map(|acc| {
            account_errors
                .get(&acc.key().composite_key())
                .map(|msg| AccountPageError {
                    provider_id: acc.provider_id.clone(),
                    uuid: acc.uuid.clone(),
                    message: msg.clone(),
                })
        })
        .collect();
    WebBotsSnapshot {
        providers: all_provider_infos(&state.custom_providers),
        custom_providers: state.custom_providers.clone(),
        accounts: state.accounts.clone(),
        selected_provider_id: state.selected_provider_id.clone(),
        active_account: state.active_account.clone(),
        warm_accounts,
        settings: state.settings.clone(),
        group_chats: state.group_chats.clone(),
        active_group_id: state.active_group_id.clone(),
        external_agents: state.external_agents.clone(),
        account_errors: errors,
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn new_uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

pub fn load_state(path: &Path) -> WebBotsPersistedState {
    let Ok(raw) = fs::read_to_string(path) else {
        return WebBotsPersistedState::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_state(path: &Path, state: &WebBotsPersistedState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| format!("序列化状态失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写入状态临时文件失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("更新状态文件失败: {e}"))?;
    Ok(())
}
