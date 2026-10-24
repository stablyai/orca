import type { OpenFile } from '../types/open-file'
import type { EditorBufferViewIndex } from './editor-buffer-views'
import {
  editorBufferIdentityKeyOf,
  editorBufferRouteEpochOf,
  type EditorBufferRouteState
} from './editor-buffer-identity-cache'

export type ConflictOverviewState = EditorBufferRouteState &
  Partial<Pick<EditorBufferViewIndex, 'editorBufferViews'>> & { openFiles: readonly OpenFile[] }

const MAX_LOOKUP_FILES = 256
const lookupFiles = new Map<string, OpenFile>()

/** One stand-in edit tab per path, so the per-tab identity cache answers repeat lookups. */
function lookupFileOf(key: string, worktreeId: string, filePath: string): OpenFile {
  let file = lookupFiles.get(key)
  if (file) {
    // Why: re-insert to mark it most recently used.
    lookupFiles.delete(key)
  } else {
    file = {
      id: filePath,
      filePath,
      relativePath: filePath,
      worktreeId,
      language: 'plaintext',
      isDirty: false,
      mode: 'edit'
    }
    if (lookupFiles.size >= MAX_LOOKUP_FILES) {
      const oldest = lookupFiles.keys().next().value
      if (oldest !== undefined) {
        lookupFiles.delete(oldest)
      }
    }
  }
  lookupFiles.set(key, file)
  return file
}

type ResolvedViews = {
  openFiles: readonly OpenFile[]
  views: ConflictOverviewState['editorBufferViews']
  epoch: object
  byPath: Map<string, OpenFile | null>
}

let resolved: ResolvedViews | null = null

/** Answers for the current tabs, record views and routes; any change by reference starts fresh. */
function resolvedViewsOf(state: ConflictOverviewState): ResolvedViews {
  const epoch = editorBufferRouteEpochOf(state)
  if (
    resolved?.openFiles !== state.openFiles ||
    resolved.views !== state.editorBufferViews ||
    resolved.epoch !== epoch
  ) {
    resolved = {
      openFiles: state.openFiles,
      views: state.editorBufferViews,
      epoch,
      byPath: new Map()
    }
  }
  return resolved
}

function resolveConflictOverviewView(
  state: ConflictOverviewState,
  lookupKey: string,
  worktreeId: string,
  filePath: string
): OpenFile | null {
  const key = editorBufferIdentityKeyOf(lookupFileOf(lookupKey, worktreeId, filePath), state)
  const viewIds = key === null ? undefined : state.editorBufferViews?.[key]
  const recordViews = viewIds ? state.openFiles.filter((file) => viewIds.includes(file.id)) : []
  return (
    recordViews.find((file) => file.worktreeId === worktreeId) ??
    // Why: this workspace's own tab (even a detached one with its own edits) outranks a borrowed view.
    state.openFiles.find(
      (file) => file.filePath === filePath && file.worktreeId === worktreeId && file.mode === 'edit'
    ) ??
    recordViews[0] ??
    null
  )
}

/**
 * The open view a conflict-review overview reads a file through, so it shows that record's current
 * text and model (read-only; the overview is never a view itself). This workspace's view of the
 * file's record, else its own edit tab, else another workspace's view; null shows disk text.
 */
export function conflictOverviewView(
  state: ConflictOverviewState,
  worktreeId: string,
  filePath: string
): OpenFile | null {
  const byPath = resolvedViewsOf(state).byPath
  const lookupKey = JSON.stringify([worktreeId, filePath])
  if (byPath.has(lookupKey)) {
    return byPath.get(lookupKey) ?? null
  }
  const view = resolveConflictOverviewView(state, lookupKey, worktreeId, filePath)
  byPath.set(lookupKey, view)
  return view
}

/** A value that changes whenever any overview file would read through a different view. */
export function conflictOverviewViewsKey(
  state: ConflictOverviewState,
  worktreeId: string,
  filePaths: readonly string[]
): string {
  return filePaths
    .map((filePath) => {
      const view = conflictOverviewView(state, worktreeId, filePath)
      return view ? JSON.stringify([view.id, view.worktreeId, view.filePath]) : ''
    })
    .join('\n')
}
