import { absolutePathToFileUri } from '@/components/editor/markdown/link-routing/markdown-internal-links'
import { getConnectionIdForFile } from '@/lib/workspace/ownership/connection-context'
import { basename } from '@/lib/path'
import { isTwinWorkspace } from '@/lib/workspace/ownership/resolve-owner'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'

/** Still the answer for flows that need a real `file://` URL (e.g. dropping a file on a browser pane). */
export const REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE =
  'Open in Orca Browser is only available for local files.'
export const TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE =
  'This project is on more than one host, so Orca cannot tell which copy to open.'

/** Localized lazily: a module constant would freeze the language at import time. */
export function remoteFileBrowserUnsupportedMessage(): string {
  return translate(
    'renderer.lib.filePreview.remoteFileUnsupported',
    'Open in Orca Browser is only available for local files.'
  )
}

export function twinFileBrowserUnsupportedMessage(): string {
  return translate(
    'renderer.lib.filePreview.twinFileUnsupported',
    'This project is on more than one host, so Orca cannot tell which copy to open.'
  )
}

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
      message: twinFileBrowserUnsupportedMessage()
    }
  }
  if (
    getConnectionIdForFile(params.worktreeId, params.filePath) !== null ||
    runtimeEnvironmentIdOrLocalUnlessTwin(state, params.worktreeId)
  ) {
    // file:// always resolves locally; serve remote files through Orca before browser rendering.
    return {
      status: 'unsupported',
      reason: 'remote-worktree',
      message: remoteFileBrowserUnsupportedMessage()
    }
  }

  return {
    status: 'ready',
    url: absolutePathToFileUri(params.filePath),
    title: basename(params.filePath) || params.filePath
  }
}
