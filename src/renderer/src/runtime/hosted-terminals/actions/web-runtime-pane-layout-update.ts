import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import type { TerminalPaneLayoutNode } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { runtimeEnvironmentIdUnlessTwin } from '../../../lib/workspace/ownership/resolve-owner'
import { useAppStore } from '../../../store/index'
import { unwrapRuntimeRpcResult } from '../../rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId
} from '../../../../../shared/workspace-layout/terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  isWebRuntimeSessionActive
} from '../../web-session-tabs-sync/identity/web-runtime-session-environment'
import { isServerFrameDrawnWorkspace } from '../../web-session-tabs-sync/frame-drawn-server-workspace-set'
import { isRecipeVmWakingRefusal } from '../../../../../shared/remote-runtime/recipe-vm-wake'

/** A push refused because the VM is still waking is sent again (each send waits for the wake in
 *  the host first), up to this many sends in all. */
export const PANE_LAYOUT_WAKING_SENDS = 4
// The newest push per tab: a retry never sends a layout a later push already replaced.
const latestPush = new Map<string, number>()
let pushSeq = 0

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
  const pushKey = `${args.worktreeId}\u0000${args.tabId}`
  const seq = ++pushSeq
  latestPush.set(pushKey, seq)
  for (let send = 1; ; send++) {
    const result = await sendPaneLayout(callEnvironment, args, hostTabId)
    const newest = latestPush.get(pushKey) === seq
    // Still waking after the host's hold: the same push lands once it is up, unless a newer one
    // for this tab has replaced it meanwhile.
    if (
      !result.sent &&
      isRecipeVmWakingRefusal(result.error) &&
      send < PANE_LAYOUT_WAKING_SENDS &&
      newest
    ) {
      continue
    }
    if (newest) {
      latestPush.delete(pushKey)
    }
    if (result.sent) {
      return true
    }
    console.warn(
      '[web-runtime-session] failed to update pane layout:',
      result.error instanceof Error ? result.error.message : String(result.error)
    )
    return false
  }
}

async function sendPaneLayout(
  callEnvironment: ReturnType<typeof captureRuntimeEnvironmentCall>,
  args: Parameters<typeof updateWebRuntimePaneLayout>[0],
  hostTabId: string
): Promise<{ sent: true } | { sent: false; error: unknown }> {
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
    return { sent: true }
  } catch (error) {
    return { sent: false, error }
  }
}
