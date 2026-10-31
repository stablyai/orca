import { WorkspacePresentationIndex } from '../../store/workspace-presentation-index'
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

const openFileIndexes = new WeakMap<readonly OpenFile[], WorkspacePresentationIndex<OpenFile[]>>()
function indexedOpenFiles(files: readonly OpenFile[]): WorkspacePresentationIndex<OpenFile[]> {
  let index = openFileIndexes.get(files)
  if (!index) {
    index = new WorkspacePresentationIndex<OpenFile[]>()
    for (const file of files) {
      const id = file.worktreeId
      const bucket = index.get(id) ?? []
      bucket.push(file)
      index = index.set(id, bucket)
    }
    openFileIndexes.set(files, index)
  }
  return index
}
/** All ingress paths share one file index per immutable array, including direct old-peer reads. */
export function webSessionOpenFilesForWorktree(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
): readonly OpenFile[] {
  if (!batchContext) {
    return indexedOpenFiles(state.openFiles).get(worktreeId) ?? []
  }
  let index = batchContext.openFilesIndex
  if (!index || index.source !== state.openFiles) {
    index = { source: state.openFiles, byWorktree: indexedOpenFiles(state.openFiles) }
    batchContext.openFilesIndex = index
  }
  return index.byWorktree.get(worktreeId) ?? []
}

/** Share the next immutable array’s index with every subsequent source in this batch. */
export function advanceWebSessionOpenFilesIndex(
  batchContext: WebSessionTabsBatchContext | undefined,
  nextOpenFiles: readonly OpenFile[],
  worktreeId: string,
  bucket: OpenFile[]
): void {
  const index = batchContext?.openFilesIndex
  if (!batchContext || !index || index.source === nextOpenFiles) {
    return
  }
  const byWorktree = index.byWorktree.set(worktreeId, bucket)
  openFileIndexes.set(nextOpenFiles, byWorktree)
  batchContext.openFilesIndex = { source: nextOpenFiles, byWorktree }
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
    // Include generated label in equality or unified titles diverge from terminal tabs.
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
