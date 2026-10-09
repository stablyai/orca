// Host-aware resolution for composer attachments (STA-1465). The composer's
// attach surfaces (file drop, file picker, image paste) receive client-local
// paths, but an SSH worktree's agent runs on the remote host — local paths must
// be uploaded first, exactly like terminal drops (docs/terminal-drop-ssh.md). A
// structured chat on a paired server uploads into that server's attachment store.

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getKnownExecutionHostIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../../shared/agent-session-write-notice-copy'
import type {
  AgentSessionAttachmentPathUploadResult,
  AgentSessionAttachmentUploadTarget
} from '../../../../shared/agent-session-attachments'
import type { AppState } from '@/store/types'
import { reportTerminalDropUploadSkipsAndFailures } from '../terminal-pane/terminal-drop-upload-report'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import { findTerminalTabWorktreeId } from './native-chat-file-link'
import {
  captureDirectSshMutationExpectation,
  type DirectSshMutationExpectation
} from '@/lib/ssh-mutation-expectation'

export type NativeChatSshAttachmentOwner = DirectSshMutationExpectation & {
  kind: 'ssh'
  connectionId: string
  worktreePath: string
}

/** A structured chat on a paired server: files upload into that server's attachment store, which
 *  checks every stored path a message names when it admits the message. */
export type NativeChatRuntimeSessionAttachmentOwner = {
  kind: 'runtime-session'
  environmentId: string
  pairingRevision: number
  sessionId: string
}

export type NativeChatAttachmentOwner =
  | { kind: 'local' }
  | NativeChatSshAttachmentOwner
  | NativeChatRuntimeSessionAttachmentOwner
  /** A terminal-backed chat on a paired server: its agent may run on that server's SSH or WSL
   *  host, which the server's store cannot reach, so it keeps refusing client files. */
  | { kind: 'runtime' }
  /** Store not hydrated / worktree unknown. Callers must not attach local
   *  paths in this window — the worktree may turn out to be remote, and the
   *  agent would silently receive paths it cannot read (see #6648). */
  | { kind: 'not-ready' }

type NativeChatAttachmentOwnerState = Pick<
  AppState,
  | 'detectedWorktreesByRepo'
  | 'floatingWorkspacePath'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'sshConnectionStates'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
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
  return resolveNativeChatAttachmentOwnerForWorktree(state, worktreeId)
}

export function resolveNativeChatAttachmentHost(
  state: NativeChatAttachmentOwnerState,
  worktreeId: string
): ExecutionHostId | null {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return getKnownExecutionHostIdForWorktree(state, worktreeId)
  }
  const runtimeId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (!runtimeId && connectionId === undefined) {
    return null
  }
  const hostId = runtimeId
    ? toRuntimeExecutionHostId(runtimeId)
    : connectionId
      ? toSshExecutionHostId(connectionId)
      : 'local'
  return findKnownWorktreeById(state, worktreeId, hostId) ? hostId : null
}

export function resolveNativeChatAttachmentOwnerForWorktree(
  state: NativeChatAttachmentOwnerState,
  worktreeId: string
): NativeChatAttachmentOwner {
  const hostId = resolveNativeChatAttachmentHost(state, worktreeId)
  if (!hostId) {
    return { kind: 'not-ready' }
  }
  if (parseExecutionHostId(hostId)?.kind === 'runtime') {
    return { kind: 'runtime' }
  }
  if (hostId === 'local') {
    return { kind: 'local' }
  }
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId === undefined) {
    return { kind: 'not-ready' }
  }
  if (connectionId === null) {
    return { kind: 'not-ready' }
  }
  const worktreePath = findKnownWorktreeById(state, worktreeId, hostId)?.path
  if (!worktreePath) {
    return { kind: 'not-ready' }
  }
  try {
    return {
      kind: 'ssh',
      connectionId,
      worktreePath,
      ...captureDirectSshMutationExpectation(state, connectionId)
    }
  } catch {
    // The connection's generation is gone (disconnect mid-attach). That is an
    // unknown owner, not a reason to throw out of the drop/IME handler.
    return { kind: 'not-ready' }
  }
}

/** The chat behind a structured composer, as the attachment owner needs it. */
export type NativeChatStructuredAttachmentSession = {
  sessionId: string
  /** Null: the chat runs on this machine. */
  runtimeEnvironmentId: string | null
}

/** A structured chat on a paired server owns its attachments by where it runs, not by worktree. */
export function resolveNativeChatRuntimeSessionAttachmentOwner(session: {
  sessionId: string
  runtimeEnvironmentId: string
}): NativeChatAttachmentOwner {
  const pairingRevision = getRuntimeEnvironmentRevision(session.runtimeEnvironmentId)
  if (pairingRevision === undefined) {
    return { kind: 'not-ready' }
  }
  return {
    kind: 'runtime-session',
    environmentId: session.runtimeEnvironmentId,
    pairingRevision,
    sessionId: session.sessionId
  }
}

export function nativeChatWorktreeNotReadyNotice(): string {
  return translate(
    'components.native-chat.composer.worktreeNotReady',
    'Worktree not ready — try again in a moment.'
  )
}

export function nativeChatAttachmentOwnerChangedNotice(): string {
  return translate(
    'components.native-chat.composer.attachmentOwnerChanged',
    'This workspace changed hosts while attaching — drop the files again.'
  )
}

export function nativeChatAttachmentUnreadableNotice(): string {
  return translate(
    'components.native-chat.composer.attachmentUnreadable',
    "Couldn't read the dropped files."
  )
}

/** One notice for every file of a drop or pick that did not attach, by name, with the cause they
 *  share when there is one. */
export function nativeChatAttachFailedNotice(names: readonly string[], cause = ''): string {
  const files = names.join(', ')
  const reason = cause.trim().replace(/[^.!?。！？]$/u, '$&.')
  return reason
    ? translate(
        'components.native-chat.composer.attachFailedBecause',
        "Couldn't attach {{files}}. {{reason}}",
        { files, reason }
      )
    : translate('components.native-chat.composer.attachFailed', "Couldn't attach {{files}}.", {
        files
      })
}

export function nativeChatTooManyAttachmentsNotice(): string {
  return translate(
    'components.native-chat.composer.tooManyAttachments',
    'Attach {{value0}} or fewer files at a time.',
    { value0: NATIVE_FILE_DROP_MAX_PATHS }
  )
}

export { nativeChatLocalAttachmentUnsupportedNotice } from './native-chat-composer-target'

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

/**
 * Ask the chat's server, right before uploading, whether it keeps chat attachments, and which
 * server process will receive the bytes. An older server gets the update notice instead of an
 * upload: a path from this machine would mean nothing to its agent.
 */
export async function prepareNativeChatSessionAttachmentUpload(
  owner: NativeChatRuntimeSessionAttachmentOwner
): Promise<
  { ok: true; target: AgentSessionAttachmentUploadTarget } | { ok: false; notice: string }
> {
  const status = await callRuntimeRpc<RuntimeStatus>(
    { kind: 'environment', environmentId: owner.environmentId },
    'status.get',
    undefined,
    { timeoutMs: 15_000, expectedEnvironmentPairingRevision: owner.pairingRevision }
  )
  if (!status.capabilities?.includes(AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY)) {
    // The same words as any write a server too old for it refuses.
    return {
      ok: false,
      notice: translate(
        'components.native-chat.writeNotice.unsupported',
        AGENT_SESSION_WRITE_NOTICE_COPY.unsupported
      )
    }
  }
  return {
    ok: true,
    target: {
      environmentId: owner.environmentId,
      sessionId: owner.sessionId,
      expectedEnvironmentPairingRevision: owner.pairingRevision,
      expectedEnvironmentRuntimeId: status.runtimeId
    }
  }
}

/**
 * Upload client-local files into the chat's store on its paired server. The chips show progress,
 * so nothing else does; the caller reports what did not attach.
 */
export function uploadNativeChatSessionAttachmentPaths(
  paths: string[],
  target: AgentSessionAttachmentUploadTarget
): Promise<AgentSessionAttachmentPathUploadResult> {
  return window.api.fs.uploadPathsToAgentSessionAttachments({ ...target, paths })
}
