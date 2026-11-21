import { WORKSPACE_GRID_VIEW_MAX_MEMBERS } from '@/lib/workspace/grid-view/workspace-grid-view-membership'

const STORAGE_KEY = 'orca.workspace-grid-view.members.v1'

export function loadWorkspaceGridViewMemberIds(): readonly string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    // Why one member is kept: adding the active workspace first saves a one-member list, and the
    // menu already shows it as a member, so a restart must not drop it.
    return [
      ...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))
    ].slice(0, WORKSPACE_GRID_VIEW_MAX_MEMBERS)
  } catch {
    return []
  }
}

export function saveWorkspaceGridViewMemberIds(memberIds: readonly string[]): void {
  try {
    if (memberIds.length === 0) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memberIds))
    }
  } catch {
    // The grid view still works for this session when device storage is unavailable.
  }
}
