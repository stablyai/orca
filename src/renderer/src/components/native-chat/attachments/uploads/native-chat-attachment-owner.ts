import {
  chatWorkspaceByTabId as findTerminalTabWorktreeId,
  structuredChatTabBySessionId,
  structuredChatWorkspacesBySessionId
} from '../../../../lib/agent-session/tab-identity/structured-chat-tab-index'
import { structuredAgentSessionTargetForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { structuredAgentSessionIdOfDraftScope } from '../../drafts/native-chat-draft-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/workspace/identity/floating-workspace-id'
import { getKnownExecutionHostIdForWorktree } from '../../../../lib/workspace/ownership/worktree-runtime-owner'
import { runtimeEnvironmentIdForWorkspaceOwner } from '../../../../lib/workspace/ownership/resolve-owner'
import { getConnectionIdFromState } from '../../../../lib/workspace/ownership/connection-owner-resolution'
import {
  toRuntimeExecutionHostId,
  getConnectionExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { findKnownWorktreeById } from '../../../../store/slices/worktrees/listing/detected-worktree-meta'
import { getRuntimeEnvironmentRevision } from '../../../../runtime/rpc/environment-revisions/runtime-environment-revision'
import type { AppState } from '../../../../store/types'
import { useAppStore } from '../../../../store/index'
import { isWebClientLocation } from '../../../../app-shell/platform/web-client-location'
import { captureDirectSshMutationExpectation } from '../../../../runtime/hosts/ssh/ssh-mutation-expectation'
import {
  resolveAgentStagingWorktreePath,
  type AgentFileStagingTarget
} from '../../../../runtime/files/imports/agent-file-staging'

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
  /** A terminal-backed chat on another host: client files are staged where its agent runs, or refused. */
  | {
      kind: 'remote'
      /** Save clipboard images on this paired host only when it directly runs the agent, never for nested SSH. */
      clipboardImageEnvironmentId?: string
      /** Absent: no server serves this worktree (direct SSH, WSL), so client files are refused. */
      staging?: NativeChatAttachmentStagingOwner
    }
  /** Unknown ownership must not admit local paths: hydration may reveal a remote agent that cannot read them. */
  | { kind: 'not-ready'; notice?: string }

/** The server that runs a terminal-backed chat's agent, and the host its worktree lives on. */
export type NativeChatAttachmentStagingOwner = {
  environmentId: string
  worktreeId: string
  executionHostId: ExecutionHostId
}

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
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (host?.kind !== 'runtime' || connectionId === undefined) {
    return { kind: 'remote' }
  }
  // Why null only: the server saves clipboard images on itself, not on its nested SSH host.
  const clipboard = connectionId === null ? { clipboardImageEnvironmentId: host.environmentId } : {}
  // The browser client holds dropped files without client paths, which staging cannot read.
  if (isWebClientLocation()) {
    return { kind: 'remote', ...clipboard }
  }
  // A nested SSH worktree stages on that SSH host, as its terminal drops do.
  const executionHostId = connectionId === null ? hostId : toSshExecutionHostId(connectionId)
  return {
    kind: 'remote',
    ...clipboard,
    staging: { environmentId: host.environmentId, worktreeId, executionHostId }
  }
}

/** Where to stage files for this chat now, resolved like a terminal drop on the same worktree. */
export function resolveNativeChatAgentStagingTarget(
  staging: NativeChatAttachmentStagingOwner
): AgentFileStagingTarget | null {
  const { environmentId, worktreeId, executionHostId } = staging
  const worktreePath = resolveAgentStagingWorktreePath(
    worktreeId,
    undefined,
    executionHostId,
    environmentId
  )
  if (!worktreePath) {
    return null
  }
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind !== 'ssh') {
    return { runtimeEnvironmentId: environmentId, worktreeId, worktreePath }
  }
  try {
    return {
      runtimeEnvironmentId: environmentId,
      worktreeId,
      worktreePath,
      ...captureDirectSshMutationExpectation(useAppStore.getState(), host.targetId, environmentId)
    }
  } catch {
    return null
  }
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

/** Resolve the chat named by a draft even when the composer that started a paste has gone. */
export function resolveNativeChatStructuredDraftAttachmentOwner(
  scopeKey: string
): NativeChatAttachmentOwner | undefined {
  const sessionId = structuredAgentSessionIdOfDraftScope(scopeKey)
  if (sessionId === null) {
    return undefined
  }
  const state = useAppStore.getState()
  const workspaces = structuredChatWorkspacesBySessionId(state.unifiedTabsByWorktree, sessionId)
  if (!workspaces.length) {
    return undefined
  }
  if (workspaces.length !== 1) {
    return { kind: 'not-ready' }
  }
  const tab = structuredChatTabBySessionId(state.unifiedTabsByWorktree, workspaces[0], sessionId)
  const target = tab && structuredAgentSessionTargetForTab(state, tab)
  if (!target) {
    return { kind: 'not-ready' }
  }
  return target.kind === 'local'
    ? { kind: 'local', structuredSessionId: sessionId }
    : resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId,
        runtimeEnvironmentId: target.environmentId
      })
}
