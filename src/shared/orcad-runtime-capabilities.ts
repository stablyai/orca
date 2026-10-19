// Why: older hosts answer orcad.terminalCensus with method-not-found, so a client asks only when
// this is advertised and otherwise treats the census as unverifiable, never as zero.
export const ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY = 'orcad.terminal-census.v1' as const

// Why: an older host answers orcad.migration.* with method-not-found; a client stages, commits or
// reads a catalog only on a host advertising this, and treats its absence as a refusal.
export const ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY = 'orcad.migration-catalog.v1' as const

// Why per kind: an older destination drops `source.kind` and cannot tell a WSL source from an SSH
// one, so a client sends a non-SSH manifest only to a host advertising that kind. Not advertised
// until a destination parses `source.kind: 'local-wsl'`.
export const ORCAD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY =
  'orcad.migration-source.local-wsl.v1' as const

// Why: older hosts have no orcad.migration.stageBlobChunk. The channel alone carries nothing: each
// blob kind also needs its own `orcad.migration-blob.<kind>.v1`, advertised once installed.
export const ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY = 'orcad.migration-blob.v1' as const

// Why: older hosts have no `accounts.setHostLaunchEnv`; a desktop that owns a host's accounts (a
// WSL host's) pushes them only to a host advertising this.
export const HOST_ACCOUNT_LAUNCH_ENV_RUNTIME_CAPABILITY = 'accounts.host-launch-env.v1' as const

export const ORCAD_RUNTIME_CAPABILITIES = [
  ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
  HOST_ACCOUNT_LAUNCH_ENV_RUNTIME_CAPABILITY
] as const
