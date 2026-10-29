/**
 * The user's own switches to a workspace (opening it, picking one of its tabs) in this window. Only
 * these may wake or start a stopped WSL distro (E9); launch restore, a reload, remounts and Orca's own
 * `setActiveWorktree` never note one. Keys are store worktree ids (`folder:<id>` for folders).
 */
const lastSwitchAt = new Map<string, number>()
const switchCounts = new Map<string, number>()
const takenCounts = new Map<string, number>()

/** Notes an activation only when its caller marked it the user's own open ('user-open'). */
export function noteUserWorkspaceOpen(
  workspaceKey: string,
  navigationIntent: 'user-open' | undefined
): void {
  if (navigationIntent === 'user-open') {
    noteUserWorkspaceSwitch(workspaceKey)
  }
}

export function noteUserWorkspaceSwitch(workspaceKey: string | null | undefined): void {
  if (!workspaceKey) {
    return
  }
  lastSwitchAt.set(workspaceKey, Date.now())
  switchCounts.set(workspaceKey, (switchCounts.get(workspaceKey) ?? 0) + 1)
}

/** Wall-clock time of the user's last switch to the workspace, if any. */
export function lastUserWorkspaceSwitchAt(workspaceKey: string): number | undefined {
  return lastSwitchAt.get(workspaceKey)
}

/**
 * True once per noted switch for each consumer; a remount or re-render with no new switch is false.
 * `withinMs` also requires the switch to be that recent (the mounts a switch itself causes).
 */
export function takeWorkspaceSwitchWake(
  workspaceKey: string,
  consumer: string,
  options: { withinMs?: number } = {}
): boolean {
  const switches = switchCounts.get(workspaceKey) ?? 0
  const takenKey = `${consumer}\0${workspaceKey}`
  if (switches <= (takenCounts.get(takenKey) ?? 0)) {
    return false
  }
  const switchedAt = lastSwitchAt.get(workspaceKey) ?? -Infinity
  if (options.withinMs !== undefined && Date.now() - switchedAt > options.withinMs) {
    return false
  }
  takenCounts.set(takenKey, switches)
  return true
}

export function resetWorkspaceSwitchUserActsForTests(): void {
  lastSwitchAt.clear()
  switchCounts.clear()
  takenCounts.clear()
}
