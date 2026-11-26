use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub enabled: bool,
    pub entry_url: String,
    pub homepage_url: String,
    pub is_custom: bool,
    pub allowed_hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomWebProviderRecord {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub entry_url: String,
    pub allowed_hosts: Vec<String>,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ProviderSpec {
    pub info: ProviderInfo,
}

fn svec(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

pub fn builtin_provider_specs() -> Vec<ProviderSpec> {
    vec![
        ProviderSpec {
            info: ProviderInfo {
                id: "muse".to_string(),
                name: "Muse · Meta".to_string(),
                short_name: "Muse".to_string(),
                enabled: true,
                entry_url: "https://muse.ai/".to_string(),
                homepage_url: "https://muse.ai/".to_string(),
                is_custom: false,
                allowed_hosts: svec(&[
                    "muse.ai",
                    "meta.com",
                    "meta.ai",
                    "metaaiusercontent.com",
                    "ecto1usercontent.com",
                    "meta-agents-apps.workers.dev",
                    "facebook.com",
                    "instagram.com",
                    "fb.com",
                    "appleid.apple.com",
                    "idmsa.apple.com",
                ]),
            },
        },
        ProviderSpec {
            info: ProviderInfo {
                id: "hark".to_string(),
                name: "Hark".to_string(),
                short_name: "Hark".to_string(),
                enabled: true,
                entry_url: "https://app.hark.com/".to_string(),
                homepage_url: "https://hark.com/".to_string(),
                is_custom: false,
                allowed_hosts: svec(&[
                    "app.hark.com",
                    "hark.com",
                    "appleid.apple.com",
                    "idmsa.apple.com",
                ]),
            },
        },
    ]
}

pub fn all_provider_infos(custom_providers: &[CustomWebProviderRecord]) -> Vec<ProviderInfo> {
    let mut list: Vec<ProviderInfo> = builtin_provider_specs()
        .into_iter()
        .map(|spec| spec.info)
        .collect();
    for custom in custom_providers {
        list.push(ProviderInfo {
            id: custom.id.clone(),
            name: custom.name.clone(),
            short_name: custom.short_name.clone(),
            enabled: true,
            entry_url: custom.entry_url.clone(),
            homepage_url: custom.entry_url.clone(),
            is_custom: true,
            allowed_hosts: custom.allowed_hosts.clone(),
        });
    }
    list
}

pub fn resolve_provider_spec(
    provider_id: &str,
    custom_providers: &[CustomWebProviderRecord],
) -> Option<ProviderSpec> {
    let clean = provider_id.trim().to_ascii_lowercase();
    all_provider_infos(custom_providers)
        .into_iter()
        .find(|info| info.id.eq_ignore_ascii_case(&clean))
        .map(|info| ProviderSpec { info })
}

pub fn host_matches(host: &str, domain: &str) -> bool {
    let host_clean = host.trim().to_ascii_lowercase();
    let domain_clean = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if host_clean.is_empty() || domain_clean.is_empty() {
        return false;
    }
    if host_clean == domain_clean {
        return true;
    }
    let suffix = format!(".{domain_clean}");
    host_clean.ends_with(&suffix)
}

pub fn normalize_custom_provider_input(
    name: &str,
    short_name: Option<&str>,
    entry_url: &str,
    allowed_hosts: Vec<String>,
    existing_ids: &[String],
    created_at_ms: u64,
) -> Result<CustomWebProviderRecord, String> {
    let name_trimmed = name.trim();
    if name_trimmed.is_empty() || name_trimmed.len() > 64 {
        return Err("站点名称不能为空且不能超过 64 个字符".to_string());
    }
    let parsed = Url::parse(entry_url.trim()).map_err(|e| format!("无效的入口 URL: {e}"))?;
    let is_localhost = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && is_localhost) {
        return Err("入口 URL 必须使用 https://（仅本机调试支持 http://localhost）".to_string());
    }
    let host = parsed
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .ok_or_else(|| "入口 URL 缺少主机名".to_string())?;

    let mut slug: String = name_trimmed
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect();
    while slug.contains("__") {
        slug = slug.replace("__", "_");
    }
    let slug = slug.trim_matches('_').to_string();
    let base_id = if slug.is_empty() {
        "custom_bot".to_string()
    } else {
        format!("custom_{slug}")
    };
    let mut candidate_id = base_id.clone();
    let mut suffix = 2usize;
    while existing_ids
        .iter()
        .any(|id| id.eq_ignore_ascii_case(&candidate_id))
    {
        candidate_id = format!("{base_id}_{suffix}");
        suffix += 1;
    }

    let short = short_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(name_trimmed)
        .chars()
        .take(24)
        .collect::<String>();

    let mut hosts: Vec<String> = allowed_hosts
        .into_iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .collect();
    if !hosts.iter().any(|h| host_matches(&host, h)) {
        hosts.insert(0, host);
    }

    Ok(CustomWebProviderRecord {
        id: candidate_id,
        name: name_trimmed.to_string(),
        short_name: short,
        entry_url: parsed.to_string(),
        allowed_hosts: hosts,
        created_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::{host_matches, normalize_custom_provider_input, resolve_provider_spec};

    #[test]
    fn host_matches_checks_exact_and_subdomains() {
        assert!(host_matches("muse.ai", "muse.ai"));
        assert!(host_matches("sub.muse.ai", "muse.ai"));
        assert!(!host_matches("evilmuse.ai", "muse.ai"));
    }

    #[test]
    fn custom_provider_validates_https_and_dedupes_id() {
        assert!(normalize_custom_provider_input(
            "Bad",
            None,
            "http://example.com",
            vec![],
            &[],
            1
        )
        .is_err());

        let first = normalize_custom_provider_input(
            "Cue",
            Some("Cue"),
            "https://cue.example.com/chat",
            vec![],
            &[],
            10,
        )
        .expect("valid custom provider");
        assert_eq!(first.id, "custom_cue");
        assert_eq!(first.allowed_hosts, vec!["cue.example.com".to_string()]);

        let second = normalize_custom_provider_input(
            "Cue",
            None,
            "https://cue2.example.com/",
            vec![],
            &[first.id.clone()],
            20,
        )
        .expect("deduped custom id");
        assert_eq!(second.id, "custom_cue_2");
        assert!(resolve_provider_spec("custom_cue", &[first]).is_some());
    }
}
