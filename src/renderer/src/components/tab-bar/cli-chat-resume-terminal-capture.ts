import { useAppStore } from '@/store'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import type { CliChatResumeSource } from './cli-chat-resume-source'
import type { RuntimeTerminalResolvePane } from '../../../../shared/runtime-types'
import { getRemoteRuntimePtyOwner } from '@/runtime/runtime-terminal-stream'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toHostSessionPaneKey,
  toHostSessionTabId
} from '../../../../shared/terminal-surface-id'

import { parseHostAuthorityKey } from '../../../../shared/host-authority'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  captureTerminalSurfaceIdentity,
  isRetainedTerminalSurfaceIdentity
} from '../../../../shared/terminal-tab-close'

/** Capture the existing host handle and incarnation before starting the destination. */
export async function captureSourceTerminal(source: CliChatResumeSource) {
  const owner = source.ptyId ? getRemoteRuntimePtyOwner(source.ptyId) : null
  if (isRemoteRuntimePtyId(source.ptyId) && !owner) {
    return null
  }
  if (!owner && source.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const leafId = source.paneKey.slice(source.tabId.length + 1)
  if (source.paneKey !== `${source.tabId}:${leafId}`) {
    return null
  }
  const state = useAppStore.getState()
  const rendererHost = owner ? getKnownExecutionHostIdForWorktree(state, source.workspaceId) : null
  const renderer = captureTerminalSurfaceIdentity(state, source.workspaceId, source.tabId, leafId)
  const sourceTarget = structuredAgentSessionTargetForHost(source.executionHostId)
  if (
    owner &&
    (sourceTarget?.kind !== 'environment' ||
      sourceTarget.environmentId !== owner.target.environmentId)
  ) {
    return null
  }
  const target = owner?.target ?? { kind: 'local' as const }
  try {
    const { terminal } = await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
      target,
      'terminal.resolvePane',
      {
        paneKey: owner ? toHostSessionPaneKey(source.paneKey) : source.paneKey,
        worktreeId: source.workspaceId
      }
    )
    const original = terminal.presentation?.identity
    const authority = parseHostAuthorityKey(source.executionHostId)
    if (
      (!owner && source.ptyId === undefined && !renderer?.hasLeaf) ||
      !original ||
      !terminal.incarnationId ||
      original.worktreeId !== source.workspaceId ||
      original.tabId !==
        (owner
          ? toHostSessionTabId(source.tabId).split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
          : source.tabId) ||
      original.leafId !== leafId ||
      (terminal.executionHostId != null && terminal.executionHostId !== authority?.at) ||
      original.ptyId !== terminal.ptyId ||
      original.incarnationId !== terminal.incarnationId
    ) {
      return null
    }
    const currentState = useAppStore.getState()
    const current = captureTerminalSurfaceIdentity(
      currentState,
      source.workspaceId,
      source.tabId,
      leafId
    )
    const currentHost = owner
      ? getKnownExecutionHostIdForWorktree(currentState, source.workspaceId)
      : null
    const matches = owner
      ? terminal.handle === owner.terminal &&
        currentHost === rendererHost &&
        (currentHost === null || currentHost === source.executionHostId) &&
        (renderer === null
          ? current === null
          : isRetainedTerminalSurfaceIdentity(renderer, current)) &&
        (renderer === null ||
          ((renderer.ptyId === null || renderer.ptyId === source.ptyId) &&
            (!renderer.hasLeaf || original.hasLeaf) &&
            (renderer.incarnationId === null || renderer.incarnationId === original.incarnationId)))
      : (source.ptyId === undefined || terminal.ptyId === source.ptyId) &&
        isRetainedTerminalSurfaceIdentity(original, renderer)
    return matches
      ? {
          target,
          handle: owner?.terminal ?? terminal.handle,
          incarnationId: terminal.incarnationId,
          presentation: terminal.presentation
        }
      : null
  } catch {
    return null
  }
}
