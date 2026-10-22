import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { basename } from '@/lib/path'
import { isTwinWorkspace } from '@/lib/resolve-owner'
import { runtimeEnvironmentIdWithLegacyFallbackUnlessTwin } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'

/** Still the answer for flows that need a real `file://` URL (e.g. dropping a file on a browser pane). */
export const REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE =
  'Open in Orca Browser is only available for local files.'
export const TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE =
  'This project is on more than one host, so Orca cannot tell which copy to open.'

export type WorkspaceFileBrowserOpenTarget =
  | {
      status: 'ready'
      url: string
      title: string
    }
  | {
      status: 'unsupported'
      message: string
      reason: 'remote-worktree'
    }

/** `file://` resolution only; remote files have no local path, so this stays local-only. */
export function getWorkspaceFileBrowserOpenTarget(params: {
  filePath: string
  worktreeId: string
}): WorkspaceFileBrowserOpenTarget {
  const state = useAppStore.getState()
  // Why: a twin reads as "no server", which must not let a file:// URL open this machine's copy.
  if (isTwinWorkspace(state, params.worktreeId)) {
    return {
      status: 'unsupported',
      reason: 'remote-worktree',
      message: TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE
    }
  }
  if (
    getConnectionIdForFile(params.worktreeId, params.filePath) !== null ||
    runtimeEnvironmentIdWithLegacyFallbackUnlessTwin(state, params.worktreeId)
  ) {
    // Why: Chromium resolves file:// URLs on the local machine. Remote files
    // need an Orca-served URL before the browser can render them correctly.
    return {
      status: 'unsupported',
      reason: 'remote-worktree',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE
    }
  }

  return {
    status: 'ready',
    url: absolutePathToFileUri(params.filePath),
    title: basename(params.filePath) || params.filePath
  }
}
