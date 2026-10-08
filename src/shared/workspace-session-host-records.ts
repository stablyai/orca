import type { WorkspaceSessionState } from './workspace-session-state-types'

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

/** The renderer's live tab catalogs, for routing a payload that carries no tab rows of its own. */
export type WorkspaceTabOwnerCatalog = {
  tabsByWorktree?: Readonly<Record<string, readonly { id: string }[]>>
  unifiedTabsByWorktree?: Readonly<Record<string, readonly { id: string; worktreeId: string }[]>>
}

/** Fill tabs the payload never mentioned from the live catalogs. Payload rows win: main merges the
 *  payload's own `tabsByWorktree` into whichever partition it lands in, so a tab-keyed row has to
 *  follow the tab row in THIS write, not a newer store state the debounce has not emitted yet. */
export function extendWorktreeIdByTabId(
  byTab: Map<string, string>,
  catalog: WorkspaceTabOwnerCatalog | undefined
): Map<string, string> {
  for (const [worktreeId, tabs] of Object.entries(catalog?.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (!byTab.has(tab.id)) {
        byTab.set(tab.id, worktreeId)
      }
    }
  }
  for (const tabs of Object.values(catalog?.unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (!byTab.has(tab.id)) {
        byTab.set(tab.id, tab.worktreeId)
      }
    }
  }
  return byTab
}

/** The workspace a pane key belongs to. A pane key is `<tabId>:<leafId>`; both the split and the
 *  stranded-partition adoption resolve it here so neither can parse it its own way. */
export function worktreeIdForPaneKey(
  worktreeIdByTabId: Map<string, string>,
  paneKey: string
): string | undefined {
  const separator = paneKey.lastIndexOf(':')
  return separator > 0 ? worktreeIdByTabId.get(paneKey.slice(0, separator)) : undefined
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the record field is created here, so it holds exactly what this merge assigns into it.
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the array field is created here, so it holds exactly what this merge pushes into it.
  const target = (out[field] ??= []) as unknown[]
  target.push(...value)
}
