/**
 * Launch panes this window made before asking the host to launch into them.
 *
 * Such a pane must not spawn until the host has taken it: before that, main knows of no launch for
 * it and would give it a shell, which the host's own spawn would then be refused over. The host
 * takes the pane when it asks this window to show the launch's tab, so the hold ends there, or when
 * the launch is over. Session-only: after a reload the pane's spawn reads the launch record like any
 * launch pane.
 */

type Hold = { released: Promise<void>; release: () => void }

const holds = new Map<string, Hold>()

// Not `makePaneKey`: that validates the leaf id, and a launch must never fail over bookkeeping.
function holdKey(tabId: string, leafId: string): string {
  return JSON.stringify([tabId, leafId])
}

/** Holds the pane's spawn; the returned function ends the hold and is safe to call twice. */
export function holdAgentLaunchPaneSpawn(tabId: string, leafId: string): () => void {
  const key = holdKey(tabId, leafId)
  let release!: () => void
  const hold: Hold = {
    released: new Promise((resolve) => {
      release = resolve
    }),
    release: () => {
      if (holds.get(key) === hold) {
        holds.delete(key)
      }
      release()
    }
  }
  holds.get(key)?.release()
  holds.set(key, hold)
  return hold.release
}

/** The host has taken the pane: its spawn now waits in main for the host's agent. */
export function releaseAgentLaunchPaneSpawn(tabId: string, leafId: string): boolean {
  const hold = holds.get(holdKey(tabId, leafId))
  hold?.release()
  return hold !== undefined
}

/** What the pane's spawn awaits first, or null when nothing holds it. */
export function agentLaunchPaneSpawnHold(
  tabId: string | undefined,
  leafId: string | undefined
): Promise<void> | null {
  return tabId && leafId ? (holds.get(holdKey(tabId, leafId))?.released ?? null) : null
}

/** Still held: the host has not taken the pane. */
export function isAgentLaunchPaneSpawnHeld(tabId: string, leafId: string): boolean {
  return holds.has(holdKey(tabId, leafId))
}
