import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { OpenFile } from '../../store/slices/editor'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import { sameStringArray } from './state-equality-core'

export function openFileEqual(a: OpenFile, b: OpenFile): boolean {
  return (
    a.id === b.id &&
    a.filePath === b.filePath &&
    a.relativePath === b.relativePath &&
    a.worktreeId === b.worktreeId &&
    a.language === b.language &&
    a.isDirty === b.isDirty &&
    a.runtimeEnvironmentId === b.runtimeEnvironmentId &&
    a.markdownPreviewSourceFileId === b.markdownPreviewSourceFileId &&
    a.markdownPreviewAnchor === b.markdownPreviewAnchor &&
    a.isPreview === b.isPreview &&
    a.isUntitled === b.isUntitled &&
    a.deleteUntouchedOnClose === b.deleteUntouchedOnClose &&
    a.externalMutation === b.externalMutation &&
    a.mirroredFromRuntimeSession === b.mirroredFromRuntimeSession &&
    a.mode === b.mode
  )
}

export function sameOpenFiles(a: readonly OpenFile[], b: readonly OpenFile[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((file, index) => openFileEqual(file, b[index]!))
}

/** This worktree's open files — the only scope a snapshot reconciles, so a batch can
 *  answer from here instead of walking every open file in the app. */
export function webSessionOpenFilesForWorktree(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
): readonly OpenFile[] {
  if (!batchContext) {
    return state.openFiles.filter((file) => file.worktreeId === worktreeId)
  }
  let index = batchContext.openFilesIndex
  if (!index || index.source !== state.openFiles) {
    const byWorktree = new Map<string, OpenFile[]>()
    for (const file of state.openFiles) {
      const bucket = byWorktree.get(file.worktreeId) ?? []
      bucket.push(file)
      byWorktree.set(file.worktreeId, bucket)
    }
    index = { source: state.openFiles, byWorktree }
    batchContext.openFilesIndex = index
  }
  return index.byWorktree.get(worktreeId) ?? []
}

/** Retargets the index at the array a snapshot just produced, re-bucketing only the
 *  worktree that changed. Rebuilding it wholesale would cost the entire array again on
 *  every snapshot, which is the cost this index exists to avoid. */
export function advanceWebSessionOpenFilesIndex(
  batchContext: WebSessionTabsBatchContext | undefined,
  nextOpenFiles: readonly OpenFile[],
  worktreeId: string
): void {
  const index = batchContext?.openFilesIndex
  if (!index || index.source === nextOpenFiles) {
    return
  }
  const bucket: OpenFile[] = []
  for (const file of nextOpenFiles) {
    if (file.worktreeId === worktreeId) {
      bucket.push(file)
    }
  }
  index.byWorktree.set(worktreeId, bucket)
  index.source = nextOpenFiles
}

/** Mirrors `openFiles.find()` first-wins lookup, which duplicate ids make observable. */
export function firstOpenFileByIdForWorktree(files: readonly OpenFile[]): Map<string, OpenFile> {
  const byId = new Map<string, OpenFile>()
  for (const file of files) {
    if (!byId.has(file.id)) {
      byId.set(file.id, file)
    }
  }
  return byId
}

export function tabEqual(a: Tab, b: Tab): boolean {
  return (
    a.id === b.id &&
    a.entityId === b.entityId &&
    a.groupId === b.groupId &&
    a.worktreeId === b.worktreeId &&
    a.executionHostId === b.executionHostId &&
    a.contentType === b.contentType &&
    a.agentSessionAgent === b.agentSessionAgent &&
    a.label === b.label &&
    // Why: the generated label is the visible tab title; ignoring it let the
    // equality bail keep a unified tab that disagreed with its terminal tab.
    a.generatedLabel === b.generatedLabel &&
    a.aiVaultTitle?.agent === b.aiVaultTitle?.agent &&
    a.aiVaultTitle?.sessionId === b.aiVaultTitle?.sessionId &&
    a.aiVaultTitle?.title === b.aiVaultTitle?.title &&
    a.customLabel === b.customLabel &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.isPreview === b.isPreview &&
    a.isPinned === b.isPinned
  )
}

export function sameUnifiedTabs(a: readonly Tab[] | undefined, b: readonly Tab[] | null): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => tabEqual(tab, right[index]!))
}

export function groupEqual(a: TabGroup, b: TabGroup): boolean {
  return (
    a.id === b.id &&
    a.worktreeId === b.worktreeId &&
    a.activeTabId === b.activeTabId &&
    sameStringArray(a.tabOrder, b.tabOrder) &&
    sameStringArray(a.recentTabIds ?? [], b.recentTabIds ?? [])
  )
}

export function sameGroups(
  a: readonly TabGroup[] | undefined,
  b: readonly TabGroup[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((group, index) => groupEqual(group, right[index]!))
}

export function toVisibleTabType(tab: Tab): WebSessionTabsSyncState['activeTabType'] {
  if (tab.contentType === 'agent-session') {
    return 'agent-session'
  }
  if (tab.contentType === 'browser' || tab.contentType === 'terminal') {
    return tab.contentType
  }
  return 'editor'
}
