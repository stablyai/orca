import { parsePaneKey } from '../stable-pane-id'
import type { AgentHookSource } from '../agent-hook-relay'
import type { HookListenerState } from './listener-state'

/** Map OpenCode1 shared-server sessions to client-observed panes: the server's frozen env stamp cannot identify attach clients. Main binds from argv/creation evidence; ingest reattributes before disposition. */
export type OpenCodeSessionBinding = {
  paneKey: string
  worktreeId?: string
  /** ms epoch of the bind; oldest-bound evicts first once capped. */
  boundAt: number
  /** How the binder learned this owner. */
  basis: 'argv' | 'creation-correlation' | 'single-pane-directory' | 'tui'
}

/** Upper bound; sessions are cheap rows but the map must not grow forever. */
export const OPENCODE_SESSION_BINDINGS_MAX = 1000

/** Per-pane launch-token cache; keyed differently from bindings but shares the same bound. */
export const OPENCODE_PANE_LAUNCH_TOKENS_MAX = 1000

/** Per-listener session→pane map; the binder writes, ingest reads. */
function bindings(state: HookListenerState): Map<string, OpenCodeSessionBinding> {
  return state.opencodeSessionPaneBySessionId
}

/** Reject blank IDs/malformed pane keys so corrupt observations cannot poison ingest. */
export function bindOpenCodeSession(
  state: HookListenerState,
  sessionId: string,
  binding: OpenCodeSessionBinding
): boolean {
  const id = sessionId.trim()
  if (!id || parsePaneKey(binding.paneKey) === null) {
    return false
  }
  const map = bindings(state)
  // Delete then set to refresh insertion-order eviction age.
  map.delete(id)
  map.set(id, binding)
  while (map.size > OPENCODE_SESSION_BINDINGS_MAX) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      break
    }
    map.delete(oldest)
  }
  return true
}

/** Pane that owns this session, if the binder has seen it. */
export function lookupOpenCodeSessionPane(
  state: HookListenerState,
  sessionId: string
): OpenCodeSessionBinding | undefined {
  return bindings(state).get(sessionId.trim())
}

/** Structural client evidence strengthens an existing owner without transferring it. */
export function bindOpenCodeTuiSession(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  sessionId: string | undefined
): void {
  if (!sessionId || source !== 'opencode' || !isOpenCodeSharedServerPost(source, body)) {
    return
  }
  if (!body || typeof body !== 'object') {
    return
  }
  if (!('opencodeTui' in body) || body.opencodeTui !== 1) {
    return
  }
  if (!('paneKey' in body) || typeof body.paneKey !== 'string') {
    return
  }
  const existing = lookupOpenCodeSessionPane(state, sessionId)
  bindOpenCodeSession(state, sessionId, {
    paneKey: existing?.paneKey ?? body.paneKey,
    worktreeId: existing
      ? existing.worktreeId
      : 'worktreeId' in body && typeof body.worktreeId === 'string'
        ? body.worktreeId
        : undefined,
    boundAt: Date.now(),
    basis: 'tui'
  })
}

/** A capable shared server cannot speak for an unknown root or override its TUI. */
export function suppressOpenCodeSharedServerPost(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  sessionId: string | undefined
): boolean {
  if (source !== 'opencode' || !isOpenCodeSharedServerPost(source, body)) {
    return false
  }
  if (!body || typeof body !== 'object') {
    return false
  }
  if ('opencodeTui' in body && body.opencodeTui === 1) {
    return false
  }
  const binding = sessionId ? lookupOpenCodeSessionPane(state, sessionId) : undefined
  return (
    binding?.basis === 'tui' ||
    ('opencodeSharedServer' in body && body.opencodeSharedServer === 1 && !binding)
  )
}

/** Remove a pane's bindings on teardown/reuse/close so it cannot keep claiming live sessions. */
export function unbindOpenCodeSessionsOfPane(state: HookListenerState, paneKey: string): number {
  let removed = 0
  for (const [sessionId, binding] of bindings(state)) {
    // Validated pane keys cannot contain hierarchical cache NUL subscopes; match exactly.
    if (binding.paneKey === paneKey) {
      bindings(state).delete(sessionId)
      removed += 1
    }
  }
  return removed
}

/** Rewrite bindings when a pane moves (e.g. detached into another tab). */
export function moveOpenCodeSessionBindings(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): void {
  if (fromPaneKey === toPaneKey || parsePaneKey(toPaneKey) === null) {
    return
  }
  for (const binding of bindings(state).values()) {
    if (binding.paneKey === fromPaneKey) {
      binding.paneKey = toPaneKey
    }
  }
}

/** Remember live pane tokens for reattributed posts; shared-server stamps carry frozen tokens that fail launch fences. */
export function trackOpenCodePaneLaunchToken(
  state: HookListenerState,
  paneKey: string,
  launchToken: string | undefined
): void {
  const token = launchToken?.trim()
  if (!token) {
    return
  }
  const map = state.lastLaunchTokenByPaneKey
  map.delete(paneKey)
  map.set(paneKey, token)
  while (map.size > OPENCODE_PANE_LAUNCH_TOKENS_MAX) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      break
    }
    map.delete(oldest)
  }
}

/** Live token for a pane, if any tokened post has arrived since startup. */
export function lookupOpenCodePaneLaunchToken(
  state: HookListenerState,
  paneKey: string
): string | undefined {
  return state.lastLaunchTokenByPaneKey.get(paneKey)
}

/** OpenCode1 compatibility: remove with OpenCode1 support. Major>=2 names its own pane; missing markers (OpenCode1/mimo-code/older plugins) may use shared servers. */
export function isOpenCodeSharedServerPost(source: AgentHookSource, body: unknown): boolean {
  if ((source !== 'opencode' && source !== 'mimo-code') || typeof body !== 'object' || !body) {
    return false
  }
  const major = 'opencodeMajor' in body ? body.opencodeMajor : undefined
  return !(typeof major === 'number' && major >= 2)
}

/** Envelope fields the rewrite may substitute, as stamped by the poster. */
export type OpenCodeStampedEnvelope = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  launchToken?: string
}

/** Reattribute bound shared-server sessions; others pass through. Use the stored pane token or none, never a frozen-token fallback (#21359). */
export function resolveOpenCodeSharedServerEnvelope(args: {
  state: HookListenerState
  source: AgentHookSource
  stamped: OpenCodeStampedEnvelope
  sessionId: string | undefined
  /** The raw post; see isOpenCodeSharedServerPost. */
  body: unknown
}): OpenCodeStampedEnvelope {
  const { state, source, stamped, sessionId } = args
  if (!isOpenCodeSharedServerPost(source, args.body) || !sessionId) {
    return stamped
  }
  const binding = lookupOpenCodeSessionPane(state, sessionId)
  if (!binding) {
    return stamped
  }
  if (
    binding.paneKey === stamped.paneKey &&
    typeof args.body === 'object' &&
    args.body &&
    'opencodeTui' in args.body &&
    args.body.opencodeTui === 1
  ) {
    return stamped
  }
  return {
    paneKey: binding.paneKey,
    // Derive tabId from the replacement pane or envelope validation rejects it.
    tabId: parsePaneKey(binding.paneKey)?.tabId ?? stamped.tabId,
    // Use only the bound worktree; falling back to the frozen stamp would misfile the row.
    worktreeId: binding.worktreeId,
    // Use the bound pane's live token or none; the server's frozen token would fail fences and poison cache.
    launchToken: lookupOpenCodePaneLaunchToken(state, binding.paneKey)
  }
}
