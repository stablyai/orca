import { CLAUDE_ENTRYPOINT_ENV } from './claude-chat-entrypoint'

// A launching Claude or Codex task's identity, messaging access and runtime selection do not belong to independent processes.
export const PARENT_AGENT_SESSION_STAMP_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  CLAUDE_ENTRYPOINT_ENV,
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_TOOL_CALL_ID',
  'CODEX_VERSION',
  'CODEX_CI',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS',
  'CODEX_PLUGIN_METRICS_OUTPUT',
  // Registered Core needs Codex Desktop's package identity, which no Orca-launched process has (#39272).
  'CODEX_WINDOWS_REGISTERED_CORE'
] as const

const stampKeys = new Set<string>(PARENT_AGENT_SESSION_STAMP_ENV_KEYS)

export function canonicalAgentSessionStampEnvKey(key: string, platform: NodeJS.Platform): string {
  const normalized = platform === 'win32' ? key.toUpperCase() : key
  return stampKeys.has(normalized) ? normalized : key
}

/** The separate launch overlay, never the merged environment, owns any deliberate session values. */
export function stripInheritedAgentSessionEnv(
  env: NodeJS.ProcessEnv,
  {
    launchEnv,
    envToDelete = [],
    platform = process.platform
  }: {
    launchEnv?: NodeJS.ProcessEnv
    envToDelete?: readonly string[]
    platform?: NodeJS.Platform
  } = {}
): void {
  const explicit = Object.entries(launchEnv ?? {})
  for (const key of Object.keys(env)) {
    if (stampKeys.has(canonicalAgentSessionStampEnvKey(key, platform))) {
      delete env[key]
    }
  }
  for (const [key, value] of explicit) {
    const canonical = canonicalAgentSessionStampEnvKey(key, platform)
    if (value !== undefined && stampKeys.has(canonical)) {
      env[canonical] = value
    }
  }
  for (const key of envToDelete) {
    const canonical = canonicalAgentSessionStampEnvKey(key, platform)
    if (stampKeys.has(canonical)) {
      delete env[canonical]
    }
  }
}
