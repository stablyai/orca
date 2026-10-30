import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { editorTabFileAccess } from '@/lib/local-file-access'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { writeRuntimeFileBytes } from '@/runtime/runtime-file-bytes-write'
import type { CustomEditorBinaryDocument } from './plugin-custom-editor-host'
import type { EditorSaveResult, EditorSaveTrigger } from './editor-save-disk-precondition'
import {
  clearSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { markEditorSaveRefusal } from './editor-save-rebaseline'
import { EditorSaveDiscardedError } from './editor-discard-epoch'
import { editorBufferSiblingViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import { bytesDocumentBoxes } from './editor-bytes-document-boxes'

const listeners = new Set<() => void>()
let unsubscribeStore: (() => void) | null = null
// Why: boxes change outside the store, so a store write that leaves the tabs alone may still need a sweep.
let boxesChangedSinceSweep = false

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function notify(): void {
  boxesChangedSinceSweep = true
  notifyListeners()
}

/** Drops a draft once its tab is clean (saved, reverted, discarded) and the entry once it closes. */
function dropSettledDrafts(state: AppState, previous: AppState): void {
  if (
    !boxesChangedSinceSweep &&
    state.openFiles === previous.openFiles &&
    state.editorBufferIdOf === previous.editorBufferIdOf &&
    state.editorBufferViews === previous.editorBufferViews
  ) {
    return
  }
  boxesChangedSinceSweep = false
  let changed = false
  const isOpen = (id: string): boolean => state.openFiles.some((file) => file.id === id)
  for (const [fileId, box] of bytesDocumentBoxes) {
    const tab = state.openFiles.find((file) => file.id === fileId)
    if (!tab) {
      bytesDocumentBoxes.delete(fileId)
      // Why: a twin still open keeps the record dirty, so it inherits the draft even if not yet shown.
      const heir = box.current.draft
        ? editorBufferSiblingViewIds(previous, fileId).find((id) => id !== fileId && isOpen(id))
        : undefined
      if (heir !== undefined && !bytesDocumentBoxes.has(heir)) {
        bytesDocumentBoxes.set(heir, box)
      }
      changed = true
    } else if (box.current.draft && !tab.isDirty) {
      box.current = { ...box.current, draft: null }
      changed = true
    }
  }
  if (bytesDocumentBoxes.size === 0) {
    unsubscribeStore?.()
    unsubscribeStore = null
  }
  if (changed) {
    notifyListeners()
  }
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function subscribeEditorBytes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The document the editor shows: the unsaved edit, else the bytes on disk. */
export function editorBytesDocument(fileId: string): CustomEditorBinaryDocument | null {
  const document = bytesDocumentBoxes.get(fileId)?.current
  return document ? (document.draft ?? document.saved) : null
}

/** The bytes just read from disk; a pending edit survives so a reload never drops it. */
export function loadEditorBytes(
  fileId: string,
  saved: CustomEditorBinaryDocument,
  savedSha256: string,
  /** `editorBytesEdits` when the read started. */
  editsAtRead: number | undefined
): void {
  unsubscribeStore ??= useAppStore.subscribe(dropSettledDrafts)
  const own = bytesDocumentBoxes.get(fileId)
  if (!own) {
    const siblings = editorBufferSiblingViewIds(useAppStore.getState(), fileId)
    const shared = siblings.map((id) => bytesDocumentBoxes.get(id)).find(Boolean)
    // Why adopt as is: the twin's box is newer than a read that may have started before its save.
    bytesDocumentBoxes.set(
      fileId,
      shared ?? { current: { saved, savedSha256, draft: null }, edits: 0 }
    )
    notify()
    return
  }
  const existing = own.current
  // Why: an edit or save since the read started is newer than what the read returns.
  if (own.edits !== editsAtRead) {
    return
  }
  // Why keep the draft's baseline: a later read must not vouch for bytes the edit never saw.
  // Why keep unchanged bytes: a new object resends the document, so an edit in flight conflicts.
  if (
    !existing.draft &&
    (existing.savedSha256 !== savedSha256 || existing.saved.fileType !== saved.fileType)
  ) {
    own.current = { saved, savedSha256, draft: null }
    notify()
  }
}

export function setEditorBytesDraft(fileId: string, draft: CustomEditorBinaryDocument): void {
  const box = bytesDocumentBoxes.get(fileId)
  if (!box) {
    return
  }
  box.current = { ...box.current, draft }
  box.edits += 1
  useAppStore.getState().markFileDirty(fileId, true)
  notify()
}

const mountedViews = new Map<string, number>()

/** Counts a mounted view, so split panes on one file share its bytes until the last one leaves. */
export function retainEditorBytes(fileId: string): void {
  mountedViews.set(fileId, (mountedViews.get(fileId) ?? 0) + 1)
}

/** The last view unmounting with nothing unsaved frees the bytes; the next mount reads them again. */
export function releaseEditorBytes(fileId: string): void {
  const remaining = (mountedViews.get(fileId) ?? 1) - 1
  if (remaining > 0) {
    mountedViews.set(fileId, remaining)
    return
  }
  mountedViews.delete(fileId)
  if (bytesDocumentBoxes.get(fileId)?.current.draft === null) {
    bytesDocumentBoxes.delete(fileId)
    notify()
  }
}

export function editorBytesEdits(fileId: string): number | undefined {
  return bytesDocumentBoxes.get(fileId)?.edits
}

export function hasEditorBytesDraft(fileId: string): boolean {
  return Boolean(bytesDocumentBoxes.get(fileId)?.current.draft)
}

/** Writes the tab's unsaved bytes, guarded by the hash of the bytes the edit started from. */
export async function saveEditorBytesDraft(
  getState: () => AppState,
  file: OpenFile,
  context: RuntimeFileOperationArgs,
  trigger: EditorSaveTrigger,
  /** A Don't Save since the request; checked at the last moment before the write. */
  discarded: () => boolean
): Promise<EditorSaveResult> {
  const box = bytesDocumentBoxes.get(file.id)
  const document = box?.current
  const draft = document?.draft
  if (!box || !document || !draft) {
    return 'written'
  }
  const remote = Boolean(context.connectionId || file.runtimeEnvironmentId?.trim())
  // Stamp before writing so the watcher's echo of this save is not taken as an outside change.
  recordSelfWrite(
    file.filePath,
    undefined,
    file.runtimeEnvironmentId,
    remote ? SELF_WRITE_REMOTE_TTL_MS : undefined
  )
  let result
  try {
    result = await writeRuntimeFileBytes(
      context,
      file.filePath,
      draft.bytes,
      editorTabFileAccess(getState(), file),
      trigger === 'overwrite'
        ? {}
        : { expectedSha256: document.savedSha256, allowMissing: trigger !== 'autosave' },
      () => {
        if (discarded()) {
          throw new EditorSaveDiscardedError()
        }
      }
    )
  } catch (error) {
    clearSelfWrite(file.filePath, file.runtimeEnvironmentId)
    if (error instanceof EditorSaveDiscardedError) {
      return trigger === 'autosave' ? 'failed' : 'written'
    }
    throw error
  }
  if (!result.ok) {
    clearSelfWrite(file.filePath, file.runtimeEnvironmentId)
    markEditorSaveRefusal(getState(), file, result.diskConflict)
    return 'blocked-stale'
  }
  const savedSha256 = await sha256Hex(draft.bytes)
  // Why any holder: the saving tab may have closed while a twin of the same file stays open.
  const holder = [...bytesDocumentBoxes].find(([, held]) => held === box)?.[0]
  if (holder !== undefined) {
    // An edit made while the write ran stays unsaved, now against the bytes just written.
    const newer = box.current.draft !== draft ? box.current.draft : null
    box.current = { saved: draft, savedSha256, draft: newer }
    box.edits += 1
    const state = getState()
    state.markFileDirty(holder, newer !== null, { written: true })
    if (state.openFiles.find((tab) => tab.id === holder)?.externalMutation) {
      state.setExternalMutation(holder, null)
    }
    notify()
  }
  return 'written'
}
