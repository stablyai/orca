import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import type { TerminalPaneLayoutNode } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { runtimeEnvironmentIdUnlessTwin } from '../../../lib/resolve-owner'
import { useAppStore } from '../../../store/index'
import { unwrapRuntimeRpcResult } from '../../rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../runtime-worktree-selector'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId
} from '../../../../../shared/workspace-layout/terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  isWebRuntimeSessionActive
} from '../../web-runtime-session-environment'
import { isServerFrameDrawnWorkspace } from '../../web-session-tabs-sync/frame-drawn-server-workspace-set'

// Push remote geometry to its host or the next authoritative snapshot reverts it.
export async function updateWebRuntimePaneLayout(args: {
  worktreeId: string
  tabId: string
  root: TerminalPaneLayoutNode | null
  expandedLeafId: string | null
  chatLeafId?: string | null
  titlesByLeafId?: Record<string, string>
  renamedLeafIds?: string[]
}): Promise<boolean> {
  // Why: a twin's edit must not reach either host on a guess; it stays local until one is chosen.
  const environmentId = runtimeEnvironmentIdUnlessTwin(
    useAppStore.getState(),
    args.worktreeId,
    'push a pane layout to its host'
  )
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  // Frame-drawn geometry uses layout.apply (sizes, moves, chat pane); only rename still needs this push.
  if (!args.renamedLeafIds?.length && isServerFrameDrawnWorkspace(environmentId, args.worktreeId)) {
    return true
  }
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId)
  const hostTabId = isWebTerminalSurfaceTabId(args.tabId)
    ? toHostSessionTabId(args.tabId)
    : args.tabId
  try {
    const response = await callEnvironment({
      method: 'session.tabs.updatePaneLayout',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        tabId: hostTabId,
        root: args.root,
        expandedLeafId: args.expandedLeafId,
        ...(args.chatLeafId !== undefined ? { chatLeafId: args.chatLeafId } : {}),
        ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {}),
        ...(args.renamedLeafIds ? { renamedLeafIds: args.renamedLeafIds } : {})
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ updated: true }>)
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to update pane layout:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}
