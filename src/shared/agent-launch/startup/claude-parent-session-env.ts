// A launching Claude's identity and messaging access do not belong to independent processes.
export const CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION'
] as const

const stampKeys = new Set<string>(CLAUDE_CHILD_SESSION_STAMP_ENV_KEYS)

export function canonicalClaudeSessionStampEnvKey(key: string, platform: NodeJS.Platform): string {
  const normalized = platform === 'win32' ? key.toUpperCase() : key
  return stampKeys.has(normalized) ? normalized : key
}

/** The separate launch overlay, never the merged environment, owns any deliberate session values. */
export function stripInheritedClaudeSessionEnv(
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
    if (stampKeys.has(canonicalClaudeSessionStampEnvKey(key, platform))) {
      delete env[key]
    }
  }
  for (const [key, value] of explicit) {
    const canonical = canonicalClaudeSessionStampEnvKey(key, platform)
    if (value !== undefined && stampKeys.has(canonical)) {
      env[canonical] = value
    }
  }
  for (const key of envToDelete) {
    const canonical = canonicalClaudeSessionStampEnvKey(key, platform)
    if (stampKeys.has(canonical)) {
      delete env[canonical]
    }
  }
}
