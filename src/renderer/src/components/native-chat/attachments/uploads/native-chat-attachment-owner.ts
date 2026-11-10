import type { AppState } from '../../../../store/types'
import { chatWorkspaceByTabId as findTerminalTabWorktreeId } from '../../../../lib/structured-chat-tab-index'

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { getKnownExecutionHostIdForWorktree } from '../../../../lib/workspace/ownership/worktree-runtime-owner'
import { runtimeEnvironmentIdForWorkspaceOwner } from '../../../../lib/workspace/ownership/resolve-owner'
import { getConnectionIdFromState } from '../../../../lib/workspace/ownership/connection-owner-resolution'
import {
  type ExecutionHostId,
  toRuntimeExecutionHostId,
  getConnectionExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { findKnownWorktreeById } from '../../../../store/slices/worktrees/listing/detected-worktree-meta'
import { getRuntimeEnvironmentRevision } from '../../../../runtime/rpc/environment-revisions/runtime-environment-revision'

/** The paired host validates every stored attachment path when admitting a structured send. */
export type NativeChatRuntimeSessionAttachmentOwner = {
  kind: 'runtime-session'
  environmentId: string
  pairingRevision: number
  sessionId: string
}

export type NativeChatAttachmentOwner =
  /** `structuredSessionId`: a structured chat on this machine, whose sends claim its pastes. */
  | { kind: 'local'; structuredSessionId?: string; stagingScope?: string }
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
  /** Files belong to the draft until its future session can receive them. */
  attachmentStagingScope?: string
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
