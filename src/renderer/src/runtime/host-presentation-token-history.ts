// Why a short history: an exit is fenced by the token current when its bytes arrived, which may
// be a snapshot or two before the one applied when the queued exit finally drains.
const MAX_TOKENS_PER_PANE = 8
const MAX_TRACKED_PANES = 512

type TokenSighting = { token: string; seenAtMs: number }

const historyByHostPane = new Map<string, TokenSighting[]>()

type HostPane = { worktreeId: string; hostTabId: string; leafId: string }

function key(pane: HostPane): string {
  return `${pane.worktreeId}\0${pane.hostTabId}\0${pane.leafId}`
}

/** Records the presentation token a paired host published for one of its terminal panes. */
export function noteHostPresentationToken(
  pane: HostPane,
  token: string | undefined,
  nowMs = Date.now()
): void {
  if (!token) {
    return
  }
  const id = key(pane)
  const history = historyByHostPane.get(id) ?? []
  if (history.at(-1)?.token === token) {
    return
  }
  history.push({ token, seenAtMs: nowMs })
  if (history.length > MAX_TOKENS_PER_PANE) {
    history.shift()
  }
  historyByHostPane.delete(id)
  historyByHostPane.set(id, history)
  if (historyByHostPane.size > MAX_TRACKED_PANES) {
    const oldest = historyByHostPane.keys().next().value
    if (oldest !== undefined) {
      historyByHostPane.delete(oldest)
    }
  }
}

/**
 * The host token this client held for a pane at `atMs` (this client's clock), or null when it held
 * none then (or it fell out of the history): without it the client cannot fence its exit.
 */
export function readHostPresentationTokenAt(pane: HostPane, atMs: number): string | null {
  const history = historyByHostPane.get(key(pane)) ?? []
  let held: string | null = null
  for (const sighting of history) {
    if (sighting.seenAtMs > atMs) {
      break
    }
    held = sighting.token
  }
  return held
}

export function resetHostPresentationTokenHistoryForTest(): void {
  historyByHostPane.clear()
}
