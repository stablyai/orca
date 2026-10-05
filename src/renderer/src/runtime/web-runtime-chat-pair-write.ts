import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeSessionTabChatViewWrite,
  RuntimeSessionTabPropsResult
} from '../../../shared/runtime-session-contracts'
import { HOST_TERMINAL_SURFACE_SEPARATOR } from '../../../shared/terminal-surface-id'
import { getRuntimeEnvironmentIdForWorktree } from '../lib/worktree-runtime-owner'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { toHostSessionTabId } from './web-terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'

export class WebRuntimeChatPairUnavailableError extends Error {
  constructor() {
    super('The paired host is not connected.')
    this.name = 'WebRuntimeChatPairUnavailableError'
  }
}

/**
 * One fenced chat-pair write to a paired host. A leaf write addresses the leaf surface (claim or
 * move); `leafId` null addresses the parent. Rejects on failure so the caller can classify it.
 */
export async function setWebRuntimeChatPair(args: {
  worktreeId: string
  terminalTabId: string
  leafId: string | null
  viewMode: 'terminal' | 'chat'
  chatViewWrite: RuntimeSessionTabChatViewWrite
}): Promise<RuntimeSessionTabPropsResult> {
  const state = useAppStore.getState()
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, args.worktreeId) ?? null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    throw new WebRuntimeChatPairUnavailableError()
  }
  const parentTabId = resolveWebRuntimeHostTabId(state, environmentId, args)
  const response = await captureRuntimeEnvironmentCall(environmentId)({
    method: 'session.tabs.setTabProps',
    params: {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: args.leafId
        ? `${parentTabId}${HOST_TERMINAL_SURFACE_SEPARATOR}${args.leafId}`
        : parentTabId,
      viewMode: args.viewMode,
      chatViewWrite: args.chatViewWrite
    },
    timeoutMs: 15_000
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: marker hosts reply with RuntimeSessionTabPropsResult; a reply without chatView is treated as a failure by the caller.
  return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeSessionTabPropsResult>)
}

/**
 * A pane's observed agent exit on a paired host that owns exits: asks the host to turn that
 * pane's chat terminal only while its presentation still carries `presentationToken`, or, with
 * no token held, only while that pane still owns chat.
 */
export async function retireWebRuntimeAgentExitChat(args: {
  worktreeId: string
  terminalTabId: string
  leafId: string
  presentationToken: string | null
}): Promise<RuntimeSessionTabPropsResult> {
  const state = useAppStore.getState()
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, args.worktreeId) ?? null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    throw new WebRuntimeChatPairUnavailableError()
  }
  const parentTabId = resolveWebRuntimeHostTabId(state, environmentId, args)
  const response = await captureRuntimeEnvironmentCall(environmentId)({
    method: 'session.tabs.setTabProps',
    params: {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: `${parentTabId}${HOST_TERMINAL_SURFACE_SEPARATOR}${args.leafId}`,
      viewMode: 'terminal',
      agentExit: args.presentationToken ? { presentationToken: args.presentationToken } : {}
    },
    timeoutMs: 15_000
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: marker hosts reply with RuntimeSessionTabPropsResult; the caller only logs a failure.
  return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeSessionTabPropsResult>)
}

/** The host's parent tab id for a paired worktree's local terminal tab. */
export function resolveWebRuntimeHostTabId(
  state: ReturnType<typeof useAppStore.getState>,
  environmentId: string,
  args: { worktreeId: string; terminalTabId: string }
): string {
  return (
    resolveHostSessionTabIdForWebSessionTab(state, {
      environmentId,
      worktreeId: args.worktreeId,
      tabId: args.terminalTabId
    }) ?? toHostSessionTabId(args.terminalTabId)
  )
}
