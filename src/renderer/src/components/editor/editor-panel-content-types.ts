import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { EditorPanelContentLoadOptions } from './useEditorPanelExternalContentEvents'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { CsvFilePreview } from './csv/csv-file-content'
import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'

/** Transient owner hydration/connection failure; retry instead of reading remote paths locally and latching access errors. */
export const WORKTREE_OWNER_NOT_READY_ERROR =
  'Connecting to the remote host… retrying once the workspace is ready.'

/** Show after connection retry exhaustion; explicit Retry starts a fresh budget. */
export const WORKTREE_OWNER_UNREACHABLE_ERROR =
  "Couldn't reach the remote host. Check the connection, then retry."

/** Selector failure means unresolved ownership, never proven deletion: cold scans, removed repos and unregistered folder workspaces share this code. Bound retries and show a terminal error without closing the tab. */
export const WORKTREE_HOST_SELECTOR_NOT_FOUND_CODE = 'selector_not_found'

/** Namespaced terminal sentinel after selector retries expire; localize by code and leave draft-aware closing to the tab strip. */
export const WORKTREE_HOST_UNRESOLVED_CODE = 'editor_host_workspace_unresolved'

/** English fallback for `loadError` alongside the code above; the error view localizes it by code. */
export const WORKTREE_HOST_UNRESOLVED_ERROR =
  "The host couldn't find this file's workspace. It may have been removed, or the host may not know about it yet. Retry, or close this tab from the tab strip."

export type FileContent = {
  mediaUrl?: string
  size?: number
  csvPreview?: CsvFilePreview
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  fileIdentity?: string
  loadError?: string
  /** Machine code from a runtime RPC failure; `loadError` alone may be prose (#21041). */
  loadErrorCode?: string
  /** Superseded by an external change; still rendered until the lazy reload lands. */
  isStale?: boolean
  /** How the loader reached the file, so a binary custom editor can page its bytes from the same host. */
  byteSource?: RuntimeFileReadArgs
}

export type DiffContent = GitDiffResult & {
  /** Superseded by an external change; still rendered until the lazy reload lands. */
  isStale?: boolean
}

export type InFlightContentRead<T> = {
  externalEventGeneration?: number
  promise: Promise<T>
}

export type EditorPanelFileContentLoader = (
  filePath: string,
  id: string,
  worktreeId?: string,
  relativePath?: string,
  options?: EditorPanelContentLoadOptions
) => Promise<void>

export type UseEditorPanelFileContentLoaderParams = {
  fileLoadRetryAttemptsRef: MutableRefObject<Record<string, number>>
  fileReadGenerationCounterRef: MutableRefObject<number>
  fileReadGenerationRef: MutableRefObject<Record<string, number>>
  openFilesRef: MutableRefObject<OpenFile[]>
  outstandingFileReadsRef: MutableRefObject<Record<string, number>>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
}
