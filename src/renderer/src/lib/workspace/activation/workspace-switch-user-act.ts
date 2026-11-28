/**
 * The user's own switches to a workspace (opening it, picking one of its tabs) in this window. Only
 * these may wake or start a stopped WSL distro (E9); launch restore, a reload, remounts and Orca's own
 * `setActiveWorktree` never note one. Keys are store worktree ids (`folder:<id>` for folders).
 */
const MAX_TRACKED_WORKSPACES = 256
const MAX_CONSUMERS_PER_WORKSPACE = 256

type WorkspaceSwitchRecord = {
  at: number
  taken: Set<string>
}

const switchesByWorkspace = new Map<string, WorkspaceSwitchRecord>()

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
  switchesByWorkspace.delete(workspaceKey)
  switchesByWorkspace.set(workspaceKey, { at: Date.now(), taken: new Set() })
  if (switchesByWorkspace.size > MAX_TRACKED_WORKSPACES) {
    const oldest = switchesByWorkspace.keys().next().value
    if (oldest !== undefined) {
      switchesByWorkspace.delete(oldest)
    }
  }
}

/** Wall-clock time of the user's last switch to the workspace, if any. */
export function lastUserWorkspaceSwitchAt(workspaceKey: string): number | undefined {
  return switchesByWorkspace.get(workspaceKey)?.at
}

/** How recent a switch must be for the mounts it causes to count as that switch (`withinMs`). */
export const WORKSPACE_SWITCH_MOUNT_WINDOW_MS = 10_000

/**
 * True once per noted switch for each consumer; a remount or re-render with no new switch is false.
 * `withinMs` also requires the switch to be that recent (the mounts a switch itself causes).
 */
export function takeWorkspaceSwitchWake(
  workspaceKey: string,
  consumer: string,
  options: { withinMs?: number } = {}
): boolean {
  const record = switchesByWorkspace.get(workspaceKey)
  if (!record || record.taken.has(consumer)) {
    return false
  }
  if (options.withinMs !== undefined && Date.now() - record.at > options.withinMs) {
    return false
  }
  if (record.taken.size >= MAX_CONSUMERS_PER_WORKSPACE) {
    const oldest = record.taken.values().next().value
    if (oldest !== undefined) {
      record.taken.delete(oldest)
    }
  }
  record.taken.add(consumer)
  return true
}

/** `takeWorkspaceSwitchWake` for a consumer the switch itself mounts or runs. */
export function takeRecentWorkspaceSwitchWake(workspaceKey: string, consumer: string): boolean {
  return takeWorkspaceSwitchWake(workspaceKey, consumer, {
    withinMs: WORKSPACE_SWITCH_MOUNT_WINDOW_MS
  })
}
