import type { WorkspaceSessionState } from '../../../shared/types'

export type WorkspaceSessionRecord = Record<string, unknown>

export function isWorkspaceSessionRecord(value: unknown): value is WorkspaceSessionRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function buildWorktreeIdByTabId(state: WorkspaceSessionState): Map<string, string> {
  const byTab = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      byTab.set(tab.id, worktreeId)
    }
  }
  // Why: unified-only tabs still need their host-owned layout and PTY records routed correctly.
  for (const tabs of Object.values(state.unifiedTabs ?? {})) {
    for (const tab of tabs) {
      if (!byTab.has(tab.id)) {
        byTab.set(tab.id, tab.worktreeId)
      }
    }
  }
  return byTab
}

export function buildWorktreeIdByFileId(state: WorkspaceSessionState): Map<string, string> {
  const byFile = new Map<string, string>()
  for (const files of Object.values(state.openFilesByWorktree ?? {})) {
    for (const file of files) {
      byFile.set(file.filePath, file.worktreeId)
    }
  }
  return byFile
}

export function mergeWorkspaceSessionRecordField(
  out: WorkspaceSessionRecord,
  field: keyof WorkspaceSessionState,
  slice: WorkspaceSessionState
): void {
  const value = slice[field]
  if (!isWorkspaceSessionRecord(value)) {
    return
  }
  const target = (out[field] ??= {}) as WorkspaceSessionRecord
  Object.assign(target, value)
}

export function mergeWorkspaceSessionArrayField(
  out: WorkspaceSessionRecord,
  field: keyof WorkspaceSessionState,
  slice: WorkspaceSessionState
): void {
  const value = slice[field]
  if (!Array.isArray(value)) {
    return
  }
  const target = (out[field] ??= []) as unknown[]
  target.push(...value)
}
