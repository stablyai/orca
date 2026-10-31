import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { selectFolderWorkspaces, selectWorktreesByRepo } from './workspace-record-selectors'
import { strictWorktreeIdentityKey } from '../../../shared/workspace-presentation'
import {
  getOpenFileExecutionHostId,
  isOpenFileOwnedByWorktree
} from '../lib/unified-tab-host-ownership'
import type { OpenFile } from './slices/editor'
import type { AppState } from './types'
import { workspacePresentationFor } from './workspace-source-state'

type FileState = { openFiles: readonly OpenFile[] } & Partial<
  Pick<
    AppState,
    | 'workspacePresentations'
    | 'worktreesByRepo'
    | 'folderWorkspaces'
    | 'activeWorktreeId'
    | 'activeWorkspaceExecutionHostId'
  >
>
const indexes = new WeakMap<readonly OpenFile[], Map<string, OpenFile[]>>()
const results = new WeakMap<object, Map<string, { inputs: unknown[]; files: OpenFile[] }>>()
const empty: OpenFile[] = []

type FileSequence = { next: WeakMap<OpenFile, FileSequence>; files?: OpenFile[] }
const fileSequences: FileSequence = { next: new WeakMap() }

// Equal current member objects share output without rooting any obsolete inventory or file.
function currentFileSequence(files: OpenFile[]): OpenFile[] {
  if (!files.length) {
    return empty
  }
  let sequence = fileSequences
  for (const file of files) {
    let next = sequence.next.get(file)
    if (!next) {
      next = { next: new WeakMap() }
      sequence.next.set(file, next)
    }
    sequence = next
  }
  return (sequence.files ??= files)
}

/** Legacy files and unified editors use the same positive owning-host membership. */
export function workspaceAdmittedFiles(state: FileState, workspaceId: string): OpenFile[] {
  let index = indexes.get(state.openFiles)
  if (!index) {
    index = new Map()
    for (const file of state.openFiles) {
      const key = strictWorktreeIdentityKey(file.worktreeId)
      const bucket = index.get(key) ?? []
      bucket.push(file)
      index.set(key, bucket)
    }
    indexes.set(state.openFiles, index)
  }
  const saved = workspacePresentationFor(state, workspaceId)
  const repoId = workspaceId.slice(0, workspaceId.indexOf('::'))
  const rows = selectWorktreesByRepo(state)?.[repoId]
  const activeHost =
    state.activeWorktreeId === workspaceId ? state.activeWorkspaceExecutionHostId : undefined
  const folders = selectFolderWorkspaces(state)
  const inputs = [state.openFiles, saved?.baseline, rows, folders, activeHost]
  const cache = results.get(state) ?? new Map()
  results.set(state, cache)
  const prior = cache.get(workspaceId)
  if (prior && inputs.every((input, at) => input === prior.inputs[at])) {
    return prior.files
  }
  const candidateKeys = saved
    ? [
        ...new Set(
          saved.baseline.map(({ source }) => strictWorktreeIdentityKey(source.workspaceId))
        )
      ]
    : [strictWorktreeIdentityKey(workspaceId)]
  const candidates =
    candidateKeys.length === 1
      ? (index.get(candidateKeys[0]) ?? empty)
      : candidateKeys.flatMap((key) => index.get(key) ?? empty)
  const matching = [...(rows ?? []), ...(folders ?? []).map(folderWorkspaceToWorktree)].filter(
    (row) => row.id === workspaceId && (!activeHost || row.hostId === activeHost)
  )
  const row = matching.length === 1 ? matching[0] : undefined
  const files = candidates.filter((file) => {
    if (saved) {
      return saved.baseline.some(
        ({ source }) =>
          source.workspaceId === file.worktreeId &&
          (getOpenFileExecutionHostId(file) === source.hostId ||
            getOpenFileExecutionHostId(file) === source.executionHostId)
      )
    }
    if (row) {
      return isOpenFileOwnedByWorktree(file, row)
    }
    if (matching.length > 1) {
      return false
    }
    return (
      file.worktreeId === workspaceId &&
      getOpenFileExecutionHostId(file) === (activeHost ?? 'local')
    )
  })
  const value = currentFileSequence(files)
  cache.set(workspaceId, { inputs, files: value })
  return value
}

export function workspaceFileDisplayId(state: FileState, file: OpenFile): string {
  const saved = workspacePresentationFor(state, file.worktreeId)
  return saved && workspaceAdmittedFiles(state, saved.displayWorkspaceId).includes(file)
    ? saved.displayWorkspaceId
    : file.worktreeId
}
