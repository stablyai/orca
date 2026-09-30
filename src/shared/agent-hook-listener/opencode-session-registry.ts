import { parsePaneKey } from '../stable-pane-id'
import type { AgentHookSource } from '../agent-hook-relay'
import type { HookListenerState } from './listener-state'

/**
 * Which pane owns one OpenCode session, as observed from the client side.
 *
 * Why this exists: OpenCode v2 serves every pane from a single shared server
 * process, so the status plugin's per-post stamp (`process.env.ORCA_PANE_KEY`)
 * is frozen to whichever pane started the server. The session id is the only
 * per-event truth that survives — every post carries it — but nothing maps it
 * back to a pane. This registry is that map, filled by the main-process binder
 * (client argv, then creation-correlation against the session store) and read
 * at ingest to reattribute posts before disposition.
 */
export type OpenCodeSessionBinding = {
  paneKey: string
  worktreeId?: string
  /** ms epoch of the bind; oldest-bound evicts first once capped. */
  boundAt: number
  /** How the binder learned this owner. */
  basis: 'argv' | 'creation-correlation' | 'single-pane-directory'
}

/** Upper bound; sessions are cheap rows but the map must not grow forever. */
export const OPENCODE_SESSION_BINDINGS_MAX = 1000

/** Per-pane launch-token cache; keyed differently from bindings but shares the same bound. */
export const OPENCODE_PANE_LAUNCH_TOKENS_MAX = 1000

/** Per-listener session→pane map; the binder writes, ingest reads. */
function bindings(state: HookListenerState): Map<string, OpenCodeSessionBinding> {
  return state.opencodeSessionPaneBySessionId
}

/**
 * Record a session owner. Ignores blank ids and malformed pane keys so a
 * corrupt binder observation can never poison ingest.
 */
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
  // Why delete-then-set: Map evicts in insertion order, so a refreshed bind
  // must move to the back or a hot session would evict as if it were the
  // oldest one.
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

/**
 * Drop every binding owned by a pane: teardown, reuse and close must not let
 * a dead pane keep claiming a live session's dots.
 * @returns Number of bindings removed.
 */
export function unbindOpenCodeSessionsOfPane(state: HookListenerState, paneKey: string): number {
  let removed = 0
  for (const [sessionId, binding] of bindings(state)) {
    // Why exact match only: bindings store validated `tabId:uuid` pane keys,
    // which cannot carry the `\0` subscopes the hierarchical pane caches use.
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

/**
 * Last launch token seen per pane, from any source's envelope. The shared
 * server's posts carry a frozen (usually empty) token, so a rewritten post
 * for a fenced pane would be suppressed without the bound pane's live token.
 * Updated on every tokened post; the fence comparison hashes it the same way.
 */
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

/** Envelope fields the rewrite may substitute, as stamped by the poster. */
export type OpenCodeStampedEnvelope = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  launchToken?: string
}

/**
 * Reattribute one shared-server post to the bound pane (#21359). Reads
 * nothing but the registry: unbound sessions and other sources pass through
 * untouched, so this is a no-op everywhere the binder has said nothing. A
 * bound session always takes the stored pane token — which may be absent,
 * in which case the post carries no token rather than the frozen stamp.
 */
export function resolveOpenCodeSharedServerEnvelope(args: {
  state: HookListenerState
  source: AgentHookSource
  stamped: OpenCodeStampedEnvelope
  sessionId: string | undefined
}): OpenCodeStampedEnvelope {
  const { state, source, stamped, sessionId } = args
  if ((source !== 'opencode' && source !== 'mimo-code') || !sessionId) {
    return stamped
  }
  const binding = lookupOpenCodeSessionPane(state, sessionId)
  if (!binding) {
    return stamped
  }
  return {
    paneKey: binding.paneKey,
    // Why derive: the envelope rejects a tabId that disagrees with the pane
    // key, so the substituted tab must come from the substituted pane.
    tabId: parsePaneKey(binding.paneKey)?.tabId ?? stamped.tabId,
    // Why no stamped fallback: a binding without a worktree (its pane row
    // carried none) combined with the stamped pane's worktree would file the
    // row under the wrong worktree. Absent is honest; wrong is not.
    worktreeId: binding.worktreeId,
    // Why the stored token or nothing: the frozen stamp carries the
    // server-starter's (usually empty) token, which a fenced pane would
    // suppress — and recording that stale token as live would poison the
    // cache for the pane's real posts. The session is the authority here,
    // not the posting process.
    launchToken: lookupOpenCodePaneLaunchToken(state, binding.paneKey)
  }
}
