import type { Dispatch, SetStateAction } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { FileContent } from './editor-panel-content-types'

// Node's fs message names the syscall and the path; IPC and runtime RPC both carry it verbatim.
// Greedy to the last quote: file names may contain apostrophes.
const MISSING_FILE_MESSAGE = /ENOENT: no such file or directory, \w+ '(.+)'/

/** True only when the failure names this exact file as missing — never a worktree or host lookup. */
export function isPathSpecificMissingFileError(error: unknown, filePath: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const missingPath = MISSING_FILE_MESSAGE.exec(message)?.[1]
  return (
    missingPath !== undefined &&
    normalizeRuntimePathForComparison(missingPath) === normalizeRuntimePathForComparison(filePath)
  )
}

/**
 * Shows a failed read. A reload of a tab that already read the file (catch-up, watch event, stale reveal) found it gone:
 * mark the tab deleted as a watch event would, and keep its last content instead of an empty error.
 * Works without any existence probe, so hosts that predate one are covered too.
 */
export function applyEditorFileLoadFailure(args: {
  error: unknown
  fileId: string
  filePath: string
  tabs: readonly OpenFile[]
  failure: FileContent
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
}): void {
  const tab = args.tabs.find((file) => file.id === args.fileId)
  if (
    !tab ||
    tab.mode !== 'edit' ||
    tab.isDirty ||
    !tab.lastKnownDiskSignature ||
    !isPathSpecificMissingFileError(args.error, args.filePath)
  ) {
    args.setFileContents((prev) => ({ ...prev, [args.fileId]: args.failure }))
    return
  }
  if (tab.externalMutation !== 'deleted' && tab.externalMutation !== 'renamed') {
    useAppStore.getState().setExternalMutation(tab.id, 'deleted')
  }
  args.setFileContents((prev) => {
    const existing = prev[args.fileId]
    if (!existing || existing.loadError !== undefined) {
      return { ...prev, [args.fileId]: args.failure }
    }
    return existing.isStale ? { ...prev, [args.fileId]: { ...existing, isStale: false } } : prev
  })
}
