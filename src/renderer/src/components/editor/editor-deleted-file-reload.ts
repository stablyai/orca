import type { Dispatch, SetStateAction } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { FileContent } from './editor-panel-content-types'

// IPC/RPC preserve fs syscall/path text; match through the last quote because filenames can contain apostrophes.
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

/** On proven file absence after a prior load, retain content and mark deleted; path-specific read errors support hosts without existence probes. */
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
