import { ORCA_HOOK_PROTOCOL_VERSION } from '../agent-hook-types'
import { REMOTE_AGENT_HOOK_ENV } from '../agent-hook-relay'
import type { HookListenerState } from './listener-state'

/** Bound the warn-once Sets so a client varying `version`/`env` per request can't grow them unbounded. */
const MAX_WARNED_KEYS = 32

/** Slowloris cap: drop requests that have not finished sending after 5 s. */
export const HOOK_REQUEST_SLOWLORIS_MS = 5_000

/** Why: old OpenCode plugin builds re-post the full accumulated reply on every streamed part (O(n²) bytes/turn); cap at ingest to bound per-event cost. */
export const OPENCODE_HOOK_TEXT_MAX_CHARS = 8_000

export function capOpenCodeHookText(text: string): string {
  return text.length > OPENCODE_HOOK_TEXT_MAX_CHARS
    ? text.slice(0, OPENCODE_HOOK_TEXT_MAX_CHARS)
    : text
}

/** Bound paneKey size (real keys are well under 200); caps per-pane caches against pathological input. Exported so non-HTTP ingest (`ingestRemote`) applies the same cap as defense-in-depth. */
export const MAX_PANE_KEY_LEN = 200
export const AMP_THREAD_ID_MAX_LENGTH = 256
export const AMP_MAX_SCOPED_THREAD_CACHE_KEYS = 32
export const GROK_SESSION_CWD_MAX_LENGTH = 4096
export const GROK_HOME_ENVELOPE_MAX_LENGTH = 4096
const CLAUDE_PROMPT_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function normalizeClaudePromptId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  return CLAUDE_PROMPT_ID_RE.test(normalized) ? normalized : undefined
}
/** Warn-once on cross-build (`version`) and dev-vs-prod (`env`) mismatches; the relay's "remote" env marker is a location tag, not a build env, so it must not warn as a stale local hook. */
export function warnOnHookEnvOrVersionMismatch(
  state: HookListenerState,
  fields: { version?: string; env?: string; expectedEnv: string }
): void {
  const { version, env, expectedEnv } = fields
  if (
    version &&
    version !== ORCA_HOOK_PROTOCOL_VERSION &&
    !state.warnedVersions.has(version) &&
    state.warnedVersions.size < MAX_WARNED_KEYS
  ) {
    state.warnedVersions.add(version)
    console.warn(
      `[agent-hooks] received hook v${version}; server expects v${ORCA_HOOK_PROTOCOL_VERSION}. ` +
        'Reinstall agent hooks from Settings to upgrade the managed script.'
    )
  }
  if (env && env !== REMOTE_AGENT_HOOK_ENV && env !== expectedEnv) {
    const key = `${env}->${expectedEnv}`
    if (!state.warnedEnvs.has(key) && state.warnedEnvs.size < MAX_WARNED_KEYS) {
      state.warnedEnvs.add(key)
      console.warn(
        `[agent-hooks] received ${env} hook on ${expectedEnv} server. ` +
          'Likely a stale terminal from another Orca install.'
      )
    }
  }
}
