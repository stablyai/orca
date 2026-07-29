// SSH-aware resolution for composer attachments (STA-1465). The composer's
// attach surfaces (file drop, file picker, image paste) receive client-local
// paths, but an SSH worktree's agent runs on the remote host — local paths must
// be uploaded first, exactly like terminal drops (docs/terminal-drop-ssh.md).

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { reportTerminalDropUploadSkipsAndFailures } from '../terminal-pane/terminal-drop-upload-report'
import {
  findTerminalTabWorktreeId,
  resolveNativeChatFileLinkContext
} from './native-chat-file-link'
import {
  captureDirectSshMutationExpectation,
  type DirectSshMutationExpectation
} from '@/lib/ssh-mutation-expectation'

export type NativeChatSshAttachmentOwner = DirectSshMutationExpectation & {
  kind: 'ssh'
  connectionId: string
  worktreePath: string
}

export type NativeChatAttachmentOwner =
  | { kind: 'local' }
  | NativeChatSshAttachmentOwner
  /** Runtime-owned (`remote:`) panes keep the composer's existing
   *  local-attachment block; runtime upload support is a separate seam. */
  | { kind: 'runtime' }
  /** Store not hydrated / worktree unknown. Callers must not attach local
   *  paths in this window — the worktree may turn out to be remote, and the
   *  agent would silently receive paths it cannot read (see #6648). */
  | { kind: 'not-ready' }

type NativeChatAttachmentOwnerState = Pick<
  AppState,
  | 'folderWorkspaces'
  | 'getKnownWorktreeById'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'sshConnectionStates'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
>

/** Resolve who owns the composer's backing worktree at attach time. Mirrors the
 *  terminal drop resolver's order: runtime owner first, then SSH vs local. */
export function resolveNativeChatAttachmentOwner(
  state: NativeChatAttachmentOwnerState,
  terminalTabId: string
): NativeChatAttachmentOwner {
  const worktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  if (!worktreeId) {
    return { kind: 'not-ready' }
  }
  if (getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    return { kind: 'runtime' }
  }
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId === undefined) {
    return { kind: 'not-ready' }
  }
  if (connectionId === null) {
    return { kind: 'local' }
  }
  const worktreePath = resolveNativeChatFileLinkContext(state, terminalTabId)?.worktreePath
  if (!worktreePath) {
    return { kind: 'not-ready' }
  }
  return {
    kind: 'ssh',
    connectionId,
    worktreePath,
    ...captureDirectSshMutationExpectation(state, connectionId)
  }
}

export function nativeChatWorktreeNotReadyNotice(): string {
  return translate(
    'components.native-chat.composer.worktreeNotReady',
    'Worktree not ready — try again in a moment.'
  )
}

/**
 * Upload client-local paths into `${worktreePath}/.orca/drops` on the SSH
 * remote and return the remote paths the agent can read (input order
 * preserved). Returns null when the upload IPC itself failed; per-file
 * skips/failures surface through the shared drop toasts.
 */
export async function uploadNativeChatAttachmentPaths(
  paths: string[],
  owner: NativeChatSshAttachmentOwner
): Promise<string[] | null> {
  const pending = toast.loading(
    translate(
      'components.native-chat.composer.uploadingAttachments',
      'Uploading {{value0}} file(s) to remote…',
      { value0: paths.length }
    )
  )
  try {
    const { resolvedPaths, skipped, failed } = await window.api.fs.resolveDroppedPathsForAgent({
      paths,
      worktreePath: owner.worktreePath,
      connectionId: owner.connectionId,
      expectedExecutionHostId: owner.expectedExecutionHostId,
      expectedSshTargetId: owner.expectedSshTargetId,
      expectedSshConnectionGeneration: owner.expectedSshConnectionGeneration
    })
    reportTerminalDropUploadSkipsAndFailures(skipped, failed)
    return resolvedPaths
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
    return null
  } finally {
    toast.dismiss(pending)
  }
}
