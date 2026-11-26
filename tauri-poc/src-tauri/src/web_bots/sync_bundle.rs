use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::BTreeMap;

use crate::web_bots::cookies::ParsedCookie;
use crate::web_bots::providers::CustomWebProviderRecord;
use crate::web_bots::storage::{
    AccountRecord, ExternalAgentRecord, GroupChatRecord, WebBotsPersistedState, WebBotsSnapshot,
};

pub const SYNC_BUNDLE_MAGIC: &str = "MAAM_SYNC";
pub const SYNC_BUNDLE_VERSION: u32 = 1;
pub const PBKDF2_ITERATIONS: u32 = 120_000;
pub const MAX_SYNC_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBundlePayload {
    pub schema_version: u32,
    pub exported_at_ms: u64,
    pub source_platform: String,
    pub accounts: Vec<AccountRecord>,
    #[serde(default)]
    pub custom_providers: Vec<CustomWebProviderRecord>,
    #[serde(default)]
    pub account_cookies: BTreeMap<String, Vec<ParsedCookie>>,
    #[serde(default)]
    pub group_chats: Vec<GroupChatRecord>,
    #[serde(default)]
    pub external_agents: Vec<ExternalAgentRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedSyncEnvelope {
    pub magic: String,
    pub version: u32,
    pub kdf: String,
    pub iterations: u32,
    pub cipher: String,
    pub salt_b64: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub created_at_ms: u64,
    pub source_platform: String,
    pub account_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSyncBundleResponse {
    pub filename: String,
    pub bundle_json: String,
    pub account_count: usize,
    pub cookie_account_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncImportSummary {
    pub added_accounts: usize,
    pub updated_accounts: usize,
    pub imported_cookie_accounts: usize,
    pub skipped_cookie_accounts: usize,
    pub merged_groups: usize,
    pub merged_external_agents: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSyncBundleResponse {
    pub snapshot: WebBotsSnapshot,
    pub summary: SyncImportSummary,
}

pub fn validate_sync_passphrase(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.chars().count() < 4 {
        return Err("同步口令至少需要 4 个字符".to_string());
    }
    if trimmed.len() > 256 {
        return Err("同步口令长度不能超过 256 字节".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn encrypt_sync_bundle(payload: &SyncBundlePayload, passphrase: &str) -> Result<String, String> {
    let pass = validate_sync_passphrase(passphrase)?;
    let plaintext = serde_json::to_vec(payload).map_err(|e| format!("序列化同步数据失败: {e}"))?;

    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    getrandom::fill(&mut salt).map_err(|e| format!("生成随机盐失败: {e}"))?;
    getrandom::fill(&mut nonce_bytes).map_err(|e| format!("生成随机 Nonce 失败: {e}"))?;

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(pass.as_bytes(), &salt, PBKDF2_ITERATIONS, &mut key);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "初始化加密器失败".to_string())?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|_| "加密同步数据失败".to_string())?;

    let env = EncryptedSyncEnvelope {
        magic: SYNC_BUNDLE_MAGIC.to_string(),
        version: SYNC_BUNDLE_VERSION,
        kdf: "pbkdf2-sha256".to_string(),
        iterations: PBKDF2_ITERATIONS,
        cipher: "aes-256-gcm".to_string(),
        salt_b64: B64.encode(salt),
        nonce_b64: B64.encode(nonce_bytes),
        ciphertext_b64: B64.encode(ciphertext),
        created_at_ms: payload.exported_at_ms,
        source_platform: payload.source_platform.clone(),
        account_count: payload.accounts.len(),
    };

    serde_json::to_string(&env).map_err(|e| format!("生成加密包失败: {e}"))
}

pub fn decrypt_sync_bundle(
    bundle_json: &str,
    passphrase: &str,
) -> Result<SyncBundlePayload, String> {
    let pass = validate_sync_passphrase(passphrase)?;
    let trimmed = bundle_json.trim();
    if trimmed.is_empty() {
        return Err("同步备份内容不能为空".to_string());
    }
    if trimmed.len() > MAX_SYNC_BODY_BYTES {
        return Err("同步备份文件过大".to_string());
    }
    let env: EncryptedSyncEnvelope = serde_json::from_str(trimmed)
        .map_err(|_| "同步备份格式无效，请确认使用 .maam 加密文件".to_string())?;
    if env.magic != SYNC_BUNDLE_MAGIC || env.version != SYNC_BUNDLE_VERSION {
        return Err("不支持的同步备份版本".to_string());
    }
    if env.cipher != "aes-256-gcm" || env.kdf != "pbkdf2-sha256" {
        return Err("不支持的加密算法".to_string());
    }
    if !(10_000..=1_000_000).contains(&env.iterations) {
        return Err("同步备份加密参数无效".to_string());
    }

    let salt = B64
        .decode(env.salt_b64.trim())
        .map_err(|_| "同步备份数据损坏（salt）".to_string())?;
    let nonce_bytes = B64
        .decode(env.nonce_b64.trim())
        .map_err(|_| "同步备份数据损坏（nonce）".to_string())?;
    let ciphertext = B64
        .decode(env.ciphertext_b64.trim())
        .map_err(|_| "同步备份数据损坏（ciphertext）".to_string())?;
    if nonce_bytes.len() != 12 {
        return Err("同步备份 nonce 长度无效".to_string());
    }

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(pass.as_bytes(), &salt, env.iterations, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "初始化解密器失败".to_string())?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "同步口令错误或备份文件已损坏".to_string())?;

    serde_json::from_slice::<SyncBundlePayload>(&plaintext)
        .map_err(|_| "同步备份内容解析失败".to_string())
}

pub fn merge_sync_payload(
    persisted: &mut WebBotsPersistedState,
    payload: &SyncBundlePayload,
) -> SyncImportSummary {
    for provider in &payload.custom_providers {
        if let Some(existing) = persisted
            .custom_providers
            .iter_mut()
            .find(|p| p.id == provider.id)
        {
            *existing = provider.clone();
        } else {
            persisted.custom_providers.push(provider.clone());
        }
    }

    let mut added_accounts = 0usize;
    let mut updated_accounts = 0usize;
    for incoming in &payload.accounts {
        if let Some(existing) = persisted
            .accounts
            .iter_mut()
            .find(|a| a.provider_id == incoming.provider_id && a.uuid == incoming.uuid)
        {
            *existing = incoming.clone();
            updated_accounts += 1;
        } else {
            persisted.accounts.push(incoming.clone());
            added_accounts += 1;
        }
    }

    let mut merged_external_agents = 0usize;
    for ext in &payload.external_agents {
        if let Some(existing) = persisted
            .external_agents
            .iter_mut()
            .find(|e| e.id == ext.id)
        {
            *existing = ext.clone();
        } else {
            persisted.external_agents.push(ext.clone());
        }
        merged_external_agents += 1;
    }

    let mut merged_groups = 0usize;
    for grp in &payload.group_chats {
        if let Some(existing) = persisted.group_chats.iter_mut().find(|g| g.id == grp.id) {
            *existing = grp.clone();
        } else {
            persisted.group_chats.push(grp.clone());
        }
        merged_groups += 1;
    }

    SyncImportSummary {
        added_accounts,
        updated_accounts,
        imported_cookie_accounts: 0,
        skipped_cookie_accounts: 0,
        merged_groups,
        merged_external_agents,
    }
}

#[cfg(test)]
mod tests {
    use super::{decrypt_sync_bundle, encrypt_sync_bundle, merge_sync_payload, SyncBundlePayload};
    use crate::web_bots::cookies::ParsedCookie;
    use crate::web_bots::storage::{AccountRecord, AuthState, WebBotsPersistedState};
    use std::collections::BTreeMap;

    fn sample_account(uuid: &str, alias: &str) -> AccountRecord {
        AccountRecord {
            provider_id: "muse".to_string(),
            uuid: uuid.to_string(),
            alias: alias.to_string(),
            auto_alias: false,
            email: Some(format!("{alias}@example.com")),
            created_at_ms: 100,
            proxy_url: None,
            timezone: None,
            avatar_url: None,
            quota_text: None,
            quota_percent: None,
            quota_detail: None,
            auth_state: AuthState::Authenticated,
            cookie_expires_at_ms: None,
            cookie_session_only: false,
            cooldown_until_ms: None,
            last_used_at_ms: None,
        }
    }

    #[test]
    fn maam_roundtrip_and_tamper_detection() {
        let mut cookies = BTreeMap::new();
        cookies.insert(
            "muse:u1".to_string(),
            vec![ParsedCookie {
                name: "sid".to_string(),
                value: "secret".to_string(),
                domain: ".muse.ai".to_string(),
                path: "/".to_string(),
                secure: true,
                http_only: true,
                same_site: Some("Lax".to_string()),
                expires: None,
            }],
        );
        let payload = SyncBundlePayload {
            schema_version: 1,
            exported_at_ms: 1_700_000_000_000,
            source_platform: "windows".to_string(),
            accounts: vec![sample_account("u1", "Alpha")],
            custom_providers: vec![],
            account_cookies: cookies,
            group_chats: vec![],
            external_agents: vec![],
        };

        let encrypted = encrypt_sync_bundle(&payload, "pass-1234").expect("encrypt");
        assert!(decrypt_sync_bundle(&encrypted, "wrong-pass").is_err());
        let tampered = encrypted.replacen("aes-256-gcm", "aes-128-gcm", 1);
        assert!(decrypt_sync_bundle(&tampered, "pass-1234").is_err());

        let decrypted = decrypt_sync_bundle(&encrypted, "pass-1234").expect("decrypt");
        assert_eq!(decrypted.accounts.len(), 1);
        assert_eq!(decrypted.accounts[0].alias, "Alpha");
        assert_eq!(decrypted.account_cookies["muse:u1"].len(), 1);
    }

    #[test]
    fn additive_merge_preserves_local_and_updates_existing() {
        let mut state = WebBotsPersistedState::default();
        state.accounts.push(sample_account("u1", "LocalOld"));
        state.accounts.push(sample_account("u-local", "KeepMe"));

        let payload = SyncBundlePayload {
            schema_version: 1,
            exported_at_ms: 200,
            source_platform: "macos".to_string(),
            accounts: vec![sample_account("u1", "RemoteNew"), sample_account("u2", "Added")],
            custom_providers: vec![],
            account_cookies: BTreeMap::new(),
            group_chats: vec![],
            external_agents: vec![],
        };

        let summary = merge_sync_payload(&mut state, &payload);
        assert_eq!(summary.added_accounts, 1);
        assert_eq!(summary.updated_accounts, 1);
        assert_eq!(state.accounts.len(), 3);
        assert_eq!(
            state
                .accounts
                .iter()
                .find(|a| a.uuid == "u1")
                .expect("updated")
                .alias,
            "RemoteNew"
        );
    }
}
