import type { GlobalSettings } from './global-settings-types'

type CodexTerminalServerIsolationSettings =
  | Partial<Pick<GlobalSettings, 'codexTerminalServerIsolation'>>
  | null
  | undefined

// Why this name: the codex shell wrapper (codex-shell-launch-preflight.ts) reads it to skip --no-daemon.
const CODEX_ISOLATE_ENV = 'ORCA_CODEX_ISOLATE'

export function isCodexTerminalServerIsolationEnabled(
  settings: CodexTerminalServerIsolationSettings
): boolean {
  return settings?.codexTerminalServerIsolation !== false
}

/** Opt-out only: with isolation on nothing is injected, so behaviour matches the pre-setting default. */
export function withCodexTerminalServerIsolationEnv(
  env: Record<string, string> | undefined,
  settings: CodexTerminalServerIsolationSettings
): Record<string, string> | undefined {
  if (isCodexTerminalServerIsolationEnabled(settings)) {
    return env
  }
  return { ...env, [CODEX_ISOLATE_ENV]: '0' }
}
