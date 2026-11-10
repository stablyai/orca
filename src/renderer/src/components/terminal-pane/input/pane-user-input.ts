// Last time a person's input reached each pane (layout leaf); the interrupted-turn continue logic
// leaves those panes alone. Entries older than the memory window are pruned when a wake settles.

const lastUserInputByPane = new Map<string, number>()
const lastUserInputByWorkspace = new Map<string, number>()
const USER_INPUT_MEMORY_MS = 30 * 60_000

/** Any person's input reached this pane (layout leaf). Called for every admitted keystroke. */
export function noteUserInputForPane(
  paneId: string,
  at = Date.now(),
  workspaceId?: string | null
): void {
  lastUserInputByPane.set(paneId, at)
  if (workspaceId) {
    lastUserInputByWorkspace.set(workspaceId, at)
  }
}

/** True when a person's input reached any pane of this workspace since `since`. */
export function workspaceHadUserInputSince(workspaceId: string, since: number): boolean {
  const at = lastUserInputByWorkspace.get(workspaceId)
  return at !== undefined && at >= since
}

/** True when a person's input reached this pane since `since` (wake typing included). */
export function paneHadUserInputSince(paneId: string, since: number): boolean {
  const at = lastUserInputByPane.get(paneId)
  return at !== undefined && at >= since
}

export function pruneUserInput(now = Date.now()): void {
  for (const map of [lastUserInputByPane, lastUserInputByWorkspace]) {
    for (const [key, at] of map) {
      if (now - at > USER_INPUT_MEMORY_MS) {
        map.delete(key)
      }
    }
  }
}

export function resetPaneUserInputForTests(): void {
  lastUserInputByPane.clear()
  lastUserInputByWorkspace.clear()
}
