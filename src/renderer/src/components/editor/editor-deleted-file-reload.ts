import type { AppState } from '@/store'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { selectWorktreeHostConnectionPhase } from '@/lib/worktree-host-connection-phase'
import { WORKTREE_OWNER_NOT_READY_ERROR } from './editor-panel-content-types'
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

export function getEditorFileLoadFailureContent(
  state: AppState,
  worktreeId: string | undefined,
  readConnectionId: string | undefined,
  err: unknown
): FileContent {
  const hostConnection = selectWorktreeHostConnectionPhase(state, worktreeId ?? null)
  // Why: a read through an SSH host that is still connecting failed on the connection,
  // not the file; the retry gate waits for it rather than showing "connection dropped".
  const hostConnecting =
    hostConnection.phase === 'connecting' &&
    readConnectionId !== undefined &&
    readConnectionId === hostConnection.targetId
  const message = hostConnecting
    ? WORKTREE_OWNER_NOT_READY_ERROR
    : err instanceof Error
      ? err.message
      : String(err)
  // Why: a host may put prose on the message and the machine token on `.code`;
  // classifiers downstream must see the token, not only its rendering (#21041).
  const loadErrorCode = !hostConnecting && err instanceof RuntimeRpcCallError ? err.code : undefined
  return {
    content: '',
    isBinary: false,
    loadError: message,
    ...(loadErrorCode ? { loadErrorCode } : {})
  }
}
