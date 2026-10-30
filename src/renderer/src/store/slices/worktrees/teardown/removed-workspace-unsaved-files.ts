import type { AppState } from '../../../types'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import {
  collectRemovalUnsavedFiles,
  currentUnsavedText,
  flushRemovalPendingEdits,
  lastViewUnsavedFiles,
  unsavedTextViewIds
} from '@/components/editor/removal-unsaved-editor-files'
import { worktreePurgeClosedFileIds } from './worktree-purge-closed-files'
import { resolveEditorModelOwner } from '@/components/editor/editor-model-owner'
import { isRemovedRuntimeHostId } from '../../stale-runtime-host-rows'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '../../../workspace-record-selectors'
import type { EditorBufferKeepRequest } from '../../editor/buffers/editor-buffer-kept'

/** Text retained only until the removal notice is dismissed or recovered. */
export type ClosedUnsavedFile = { fileId: string; filePath: string; content: string }

/** File id -> the exact text a removal dialog listed when the user confirmed discarding it. */
export type ConfirmedUnsavedDiscards = ReadonlyMap<string, string>

let pendingNotice: {
  token: number
  /** A closing write may have kept records under this token. */
  keeps: boolean
  files: Map<string, { file: ClosedUnsavedFile; workspace: string }>
  discarded: Set<string>
} | null = null
let lastNoticeToken = 0

/** Snapshots the listed text; only the confirmed removal's own teardown may discard it. */
export function confirmUnsavedDiscard(
  getState: () => AppState,
  targets: readonly WorktreePurgeTarget[]
): ConfirmedUnsavedDiscards {
  const files = collectRemovalUnsavedFiles(getState, targets)
  const state = getState()
  const confirmed = new Map<string, string>()
  for (const file of files) {
    const text = currentUnsavedText(state, file)
    if (text !== undefined) {
      for (const id of unsavedTextViewIds(state, file)) {
        confirmed.set(id, text)
      }
    }
  }
  return confirmed
}

/** Commits delayed views' text for the tabs a purge of `targets` closes. */
export function flushPurgedWorkspaceEdits(
  state: AppState,
  targets: readonly WorktreePurgeTarget[]
): void {
  flushRemovalPendingEdits(state, worktreePurgeClosedFileIds(state, targets))
}

/** Superset flush for a host retirement: tabs owned by a removed host, or whose owner is unknown. */
export function flushRetiredHostEdits(state: AppState, removed: ReadonlySet<string>): void {
  flushRemovalPendingEdits(
    state,
    state.openFiles.flatMap((file) => {
      const owner = resolveEditorModelOwner(file, state)
      const retired =
        !owner.hostId ||
        (owner.environmentId !== null && removed.has(owner.environmentId)) ||
        isRemovedRuntimeHostId(owner.hostId, removed)
      return retired ? [file.id] : []
    })
  )
}

function workspaceLabel(s: AppState, worktreeId: string): string {
  const worktree = Object.values(selectWorktreesByRepo(s) ?? {})
    .flat()
    .find((candidate) => candidate.id === worktreeId)
  const folder = (selectFolderWorkspaces(s) ?? []).find(
    (candidate) => folderWorkspaceKey(candidate.id) === worktreeId
  )
  return worktree?.displayName ?? folder?.name ?? worktreeId
}

/** Retain unsaved text/models until notice recovery/dismissal; microtask merges committed purge notices. Drop only text exactly confirmed for discard in this batch; return keep token for closing writes. */
export function noticeRemovedUnsavedFiles(
  s: AppState,
  removedFileIds: ReadonlySet<string>,
  confirmed?: ConfirmedUnsavedDiscards
): EditorBufferKeepRequest | undefined {
  const keep = new Set<string>()
  let notice: NonNullable<typeof pendingNotice> | null = null
  try {
    for (const file of removedFileIds.size > 0 ? lastViewUnsavedFiles(s, removedFileIds) : []) {
      const content = currentUnsavedText(s, file)
      if (content === undefined) {
        console.warn('[editor] removed workspace closed a dirty tab with no text to recover', {
          filePath: file.filePath
        })
        continue
      }
      notice = pendingNotice ??= startNotice()
      if (confirmed?.get(file.id) === content) {
        notice.files.delete(file.id)
        notice.discarded.add(file.id)
        continue
      }
      if (notice.discarded.has(file.id)) {
        continue
      }
      if (!notice.files.has(file.id)) {
        notice.files.set(file.id, {
          file: { fileId: file.id, filePath: file.filePath, content },
          workspace: workspaceLabel(s, file.worktreeId)
        })
      }
      // Why every call: a removal closes tabs over several writes, each carrying its own request.
      for (const id of unsavedTextViewIds(s, file)) {
        keep.add(id)
      }
    }
  } catch (error) {
    console.error('[editor] capturing unsaved edits from a removed workspace failed', error)
  }
  if (!notice || keep.size === 0) {
    return undefined
  }
  notice.keeps = true
  return { viewIds: keep, notice: notice.token }
}

function startNotice(): NonNullable<typeof pendingNotice> {
  queueMicrotask(showPendingNotice)
  lastNoticeToken += 1
  return { token: lastNoticeToken, keeps: false, files: new Map(), discarded: new Set() }
}

function showPendingNotice(): void {
  const notice = pendingNotice
  pendingNotice = null
  if (!notice) {
    return
  }
  const { token } = notice
  const entries = [...notice.files.values()]
  if (entries.length === 0) {
    if (notice.keeps) {
      releaseNotice(token)
    }
    return
  }
  const closed = entries.map((entry) => entry.file)
  const label = [...new Set(entries.map((entry) => entry.workspace))].join(', ')
  console.warn('[editor] removed workspace closed files with unsaved edits', {
    workspaces: label,
    filePaths: closed.map((file) => file.filePath)
  })
  // Why lazy: keeps toast and editor-open code out of the store's import graph.
  void import('@/components/editor/closed-unsaved-files-toast')
    .then((module) => module.showClosedUnsavedFilesToast(closed, label, token))
    .catch((error) => {
      console.error('[editor] showing the unsaved edits notice failed', error)
      // Why: with no notice to dismiss, nothing else would ever release the kept records.
      releaseNotice(token)
    })
}

function releaseNotice(token: number): void {
  void import('@/store').then(({ useAppStore }) =>
    useAppStore.getState().releaseKeptEditorBuffers(token)
  )
}
