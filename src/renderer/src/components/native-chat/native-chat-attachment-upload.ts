import {
  lastVerifiedRuntimeStatus,
  isRuntimeHostContactRevoked
} from '../../../../shared/runtime-host-status'
import { useAppStore } from '@/store'
// Upload structured-chat client paths to their paired host; other remote chats cannot read client-local files.

import { translate } from '@/i18n/i18n'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  getConnectionExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
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
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import { findTerminalTabWorktreeId } from './native-chat-file-link'

/** The paired host validates every stored attachment path when admitting a structured send. */
export type NativeChatRuntimeSessionAttachmentOwner = {
  kind: 'runtime-session'
  environmentId: string
  pairingRevision: number
  sessionId: string
}

export type NativeChatAttachmentOwner =
  /** `structuredSessionId`: a structured chat on this machine, whose sends claim its pastes. */
  | { kind: 'local'; structuredSessionId?: string }
  | NativeChatRuntimeSessionAttachmentOwner
  /** Refuse client paths for terminal-backed remote or nested SSH/WSL chats; the paired store may not reach their agent. */
  | {
      kind: 'remote'
      /** Save clipboard images on this paired host only when it directly runs the agent, never for nested SSH. */
      clipboardImageEnvironmentId?: string
    }
  /** Unknown ownership must not admit local paths: hydration may reveal a remote agent that cannot read them. */
  | { kind: 'not-ready'; notice?: string }

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

/** Resolve at attach time in terminal-drop order: runtime owner before SSH/local routing. */
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
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
  // Why: an upload writes files; with two hosts publishing this id it must not land on either.
  if (owner.kind === 'ambiguous') {
    return null
  }
  const runtimeId = owner.environmentId
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (!runtimeId && connectionId === undefined) {
    return null
  }
  const hostId = runtimeId
    ? toRuntimeExecutionHostId(runtimeId)
    : getConnectionExecutionHostId(connectionId)
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
  if (hostId === 'local') {
    return { kind: 'local' }
  }
  const host = parseExecutionHostId(hostId)
  // Why null only: a non-null connectionId names the server's nested SSH host, which it does not serve.
  if (host?.kind === 'runtime' && getConnectionIdFromState(state, worktreeId) === null) {
    return { kind: 'remote', clipboardImageEnvironmentId: host.environmentId }
  }
  return { kind: 'remote' }
}

export type NativeChatStructuredAttachmentSession = {
  sessionId: string
  /** Null: the chat runs on this machine. */
  runtimeEnvironmentId: string | null
  /** The host has not confirmed this chat, so nothing can be uploaded into it. */
  sessionPending?: boolean
  sessionPendingNotice?: string
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

/** Name every failed attachment and include their common cause when available. */
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

/** Check attachment capability and receiving process before uploading; older hosts need an update, never a client-local path. */
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

/** Upload to the paired chat store; chips own progress display and callers report failures. */
export function uploadNativeChatSessionAttachmentPaths(
  paths: string[],
  target: AgentSessionAttachmentUploadTarget
): Promise<AgentSessionAttachmentPathUploadResult> {
  return window.api.fs.uploadPathsToAgentSessionAttachments({ ...target, paths })
}

/** The runtime status slice evicts replaced peers and accepts only current pairing snapshots. */
export function cachedNativeChatPasteUploadTarget(
  owner: NativeChatRuntimeSessionAttachmentOwner
): AgentSessionAttachmentUploadTarget | null {
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(owner.environmentId)
  const status = isRuntimeHostContactRevoked(entry) ? null : lastVerifiedRuntimeStatus(entry)
  if (!status?.capabilities?.includes(AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY)) {
    return null
  }
  return {
    environmentId: owner.environmentId,
    sessionId: owner.sessionId,
    expectedEnvironmentPairingRevision: owner.pairingRevision,
    expectedEnvironmentRuntimeId: status.runtimeId
  }
}
