// Tabs this window drew, closed or moved before main answered, in a layout-owner build: frames
// keep each as the window shows it until main's answer is in, then redraw its workspaces, so a
// frame sent before main had the change neither drops a just-drawn tab nor brings back a closed one.

/** A workspace's held tabs, by tab-bar or entity id; `groupLayout`: the group sizes the window set. */
export type DrawnTabHold = { workspace: string; ids: readonly string[]; groupLayout?: true }

const held = new Map<string, Map<string, number>>()
const redrawListeners = new Set<(workspaces: readonly string[]) => void>()

/** The tree key of a workspace's group sizes, never a tab id. */
const GROUP_LAYOUT = '\0group-layout'

function count(workspace: string, id: string, by: 1 | -1): void {
  const ids = held.get(workspace) ?? new Map<string, number>()
  const next = (ids.get(id) ?? 0) + by
  if (next > 0) {
    ids.set(id, next)
  } else {
    ids.delete(id)
  }
  if (ids.size > 0) {
    held.set(workspace, ids)
  } else {
    held.delete(workspace)
  }
}

function keysOf(hold: DrawnTabHold): string[] {
  return hold.groupLayout ? [...hold.ids, GROUP_LAYOUT] : [...hold.ids]
}

/** Keeps these as drawn until the release, which redraws their workspaces; a second release is a no-op. */
export function holdDrawnTabs(holds: readonly DrawnTabHold[]): () => void {
  for (const hold of holds) {
    for (const id of keysOf(hold)) {
      count(hold.workspace, id, 1)
    }
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    for (const hold of holds) {
      for (const id of keysOf(hold)) {
        count(hold.workspace, id, -1)
      }
    }
    const workspaces = [...new Set(holds.map((hold) => hold.workspace))]
    for (const listener of redrawListeners) {
      listener(workspaces)
    }
  }
}

export function isDrawnTabHeld(workspace: string, id: string): boolean {
  return held.get(workspace)?.has(id) ?? false
}

export function isDrawnGroupLayoutHeld(workspace: string): boolean {
  return isDrawnTabHeld(workspace, GROUP_LAYOUT)
}

export function holdsDrawnTabs(workspace: string): boolean {
  return held.has(workspace)
}

export function onDrawnTabsRedraw(listener: (workspaces: readonly string[]) => void): () => void {
  redrawListeners.add(listener)
  return () => redrawListeners.delete(listener)
}

export function _resetDrawnTabHoldsForTests(): void {
  held.clear()
  redrawListeners.clear()
}
