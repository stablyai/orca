import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import {
  getClientCreationActionPolicy,
  LOCAL_BROWSER_UNAVAILABLE_MESSAGE
} from '@/lib/client-creation-action-policy'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { basename, getRelativePathInsideRoot } from '@/lib/path'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'

/** Used when the file owner has no browser or preview channel. */
export const REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE =
  'Open in Orca Browser is unavailable for this file.'

/** Translate at call time so the message uses the current locale. */
function pairedOutsideWorktreeMessage(): string {
  return translate(
    'auto.lib.file.preview.pairedOutsideWorktree',
    "Files outside the workspace can't be previewed on a paired server yet."
  )
}

/** The web client streams server-owned files; Electron uses its local document preview. */
export type WorkspaceFilePreviewPlan =
  | { status: 'browser-tab'; url: string; title: string }
  | { status: 'doc-preview' }
  | { status: 'runtime-browser-tab'; url: string; title: string; environmentId: string }
  | { status: 'unsupported'; message: string; reason: 'no-channel' | 'outside-worktree' }

/** Choose a preview on the file's owner without reading a server path on the client. */
export function getWorkspaceFilePreviewPlan(
  state: AppState,
  worktreeId: string,
  filePath: string
): WorkspaceFilePreviewPlan {
  const connectionId = getConnectionIdForFileFromState(state, worktreeId, filePath)
  if (connectionId === undefined) {
    // Why: an unresolved owner can't pick a channel — reading it locally would hand a
    // remote path to this machine's filesystem.
    return {
      status: 'unsupported',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
      reason: 'no-channel'
    }
  }
  if (connectionId !== null) {
    if (isPairedWebClientWindow()) {
      return {
        status: 'unsupported',
        message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
        reason: 'no-channel'
      }
    }
    return { status: 'doc-preview' }
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (runtimeEnvironmentId) {
    const worktreeRoot = state.getKnownWorktreeById(worktreeId)?.path ?? null
    if (worktreeRoot && !getRelativePathInsideRoot(filePath, worktreeRoot)) {
      return {
        status: 'unsupported',
        message: pairedOutsideWorktreeMessage(),
        reason: 'outside-worktree'
      }
    }
    if (isPairedWebClientWindow()) {
      if (!worktreeRoot) {
        return {
          status: 'unsupported',
          message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
          reason: 'no-channel'
        }
      }
      const availability = getClientCreationActionPolicy(state, worktreeId)['managed-browser']
      if (availability.state !== 'enabled') {
        return { status: 'unsupported', message: availability.reason, reason: 'no-channel' }
      }
      if (availability.provider !== 'paired-runtime') {
        return {
          status: 'unsupported',
          message: LOCAL_BROWSER_UNAVAILABLE_MESSAGE,
          reason: 'no-channel'
        }
      }
      return {
        status: 'runtime-browser-tab',
        url: absolutePathToFileUri(filePath),
        title: basename(filePath) || filePath,
        environmentId: runtimeEnvironmentId
      }
    }
    return { status: 'doc-preview' }
  }
  const availability = getClientCreationActionPolicy(state, worktreeId)['managed-browser']
  if (availability.state !== 'enabled') {
    return { status: 'unsupported', message: availability.reason, reason: 'no-channel' }
  }
  if (isPairedWebClientWindow()) {
    return {
      status: 'unsupported',
      message: LOCAL_BROWSER_UNAVAILABLE_MESSAGE,
      reason: 'no-channel'
    }
  }
  return {
    status: 'browser-tab',
    url: absolutePathToFileUri(filePath),
    title: basename(filePath) || filePath
  }
}
