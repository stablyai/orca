// Why (#11941): an interactive Codex TUI can attach to an app-server that was
// already running before Orca opened the pane. Hook commands then execute in
// that daemon's environment, which has none of the pane-scoped
// ORCA_AGENT_HOOK_* values, and Orca's managed hook script exits successfully
// when they are missing — so every lifecycle event is silently dropped.
//
// Codex only reuses an implicit local daemon for a launch that carries no
// config override, so a launch-scoped `-c features.hooks=true` gives this pane
// its own app-server, started from the PTY that has Orca's hook coordinates.
// The override is also the honest statement of intent: Orca needs hooks on for
// the session it is launching.
//
// `-c` rather than `--enable hooks`: `--enable` is validated against the CLI's
// feature registry and hard-errors on a key it does not know, which would turn
// a hook gap into a launch failure on older Codex builds. An unrecognized
// `[features]` key in a `-c` override is ignored instead.

import type { TuiAgent } from './tui-agent'

export const CODEX_HOOK_FEATURE_KEY = 'features.hooks'
const CODEX_HOOK_LAUNCH_OVERRIDE = `${CODEX_HOOK_FEATURE_KEY}=true`

function decidesHooks(token: string): boolean {
  const trimmed = token.trim()
  if (trimmed === 'hooks') {
    return false
  }
  return (
    trimmed.startsWith(`${CODEX_HOOK_FEATURE_KEY}=`) ||
    trimmed === `-c${CODEX_HOOK_FEATURE_KEY}` ||
    trimmed.startsWith(`-c${CODEX_HOOK_FEATURE_KEY}=`) ||
    trimmed.startsWith(`--config=${CODEX_HOOK_FEATURE_KEY}=`)
  )
}

/** True when the user's own tokens already decide the hooks feature, in which
 *  case Orca must not overrule them (an explicit `--disable hooks` included). */
export function launchTokensDecideCodexHooks(tokens: readonly string[]): boolean {
  return tokens.some((token, index) => {
    if (decidesHooks(token)) {
      return true
    }
    if (token === '--enable' || token === '--disable') {
      return tokens[index + 1]?.trim() === 'hooks'
    }
    if (token === '-c' || token === '--config') {
      return decidesHooks(tokens[index + 1] ?? '')
    }
    return false
  })
}

export function planCodexRemoteHookLaunchArgs(input: {
  agent: TuiAgent
  /** The platform the agent command runs on, not the machine driving Orca. */
  platform: NodeJS.Platform
  isRemote?: boolean
  /** Orca's managed hooks are on for this agent on this host. */
  hooksEnabled?: boolean
  /** Tokens the launch already carries: user CLI args and command override. */
  launchTokens?: readonly string[]
}): readonly string[] {
  if (input.agent !== 'codex' || !input.isRemote || !input.hooksEnabled) {
    return []
  }
  // Why: Windows remotes take the relay-injected env path, and the POSIX
  // app-server reuse this works around does not apply there.
  if (input.platform === 'win32') {
    return []
  }
  if (launchTokensDecideCodexHooks(input.launchTokens ?? [])) {
    return []
  }
  return ['-c', CODEX_HOOK_LAUNCH_OVERRIDE]
}
