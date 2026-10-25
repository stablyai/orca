import type { PersistedDesktopWindowState } from './desktop-window-state-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { worktreeWorkspaceKey } from './workspace-scope'

export function migrateDesktopWindowWorktreeIdentity(
  windows: Record<string, PersistedDesktopWindowState> | undefined,
  oldId: string,
  newId: string,
  migrateSession: (session: Partial<WorkspaceSessionState>) => boolean
): boolean {
  let changed = false
  for (const window of Object.values(windows ?? {})) {
    const selected = window.ui?.lastActiveWorktreeId
    if (selected === oldId || selected?.endsWith(`|${oldId}`)) {
      window.ui = {
        ...window.ui,
        lastActiveWorktreeId: selected.slice(0, selected.length - oldId.length) + newId
      }
      changed = true
    }
    for (const view of Object.values(window.viewsByHostId ?? {})) {
      changed = migrateSession(view) || changed
      for (const record of [view.groups, view.lastFocusedAt, view.editorDrafts]) {
        for (const [oldKey, newKey] of [
          [oldId, newId],
          [worktreeWorkspaceKey(oldId), worktreeWorkspaceKey(newId)]
        ]) {
          if (Object.hasOwn(record, oldKey)) {
            record[newKey] = record[oldKey]
            delete record[oldKey]
            changed = true
          }
        }
      }
    }
  }
  return changed
}
