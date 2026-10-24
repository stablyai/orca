import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/terminal-leaf-move'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { runtimeEnvironmentIdUnlessTwin } from '../lib/resolve-owner'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  captureRuntimeEnvironmentCall,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'

// Why: leaf-to-tab membership is host-authoritative for remote tabs; a local-only move reverts on the next snapshot.
export async function moveWebRuntimeLeafToNewTab(
  request: TerminalLeafMoveRequest
): Promise<TerminalLeafMoveResult | null> {
  const environmentId = runtimeEnvironmentIdUnlessTwin(
    useAppStore.getState(),
    request.worktreeId,
    'move a pane to a new tab on its host'
  )
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return null
  }
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId)
  try {
    const response = await callEnvironment({
      method: 'session.tabs.movePaneToNewTab',
      params: {
        worktree: toRuntimeWorktreeSelector(request.worktreeId),
        sourceTabId: toHostSessionTabId(request.sourceTabId),
        targetTabId: toHostSessionTabId(request.targetTabId),
        leafId: request.leafId
      },
      timeoutMs: 15_000
    })
    const result = unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TerminalLeafMoveResult>)
    // The host names its own pty; this window keeps the mirrored id it already attached to.
    return result.status === 'moved' ? { status: 'moved', ptyId: request.ptyId } : result
  } catch (error) {
    // Why: an older host lacks the method; not_held keeps today's local-only move.
    console.warn(
      '[web-runtime-session] failed to move pane to new tab:',
      error instanceof Error ? error.message : String(error)
    )
    return { status: 'not_held' }
  }
}
