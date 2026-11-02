import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult
} from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  clearWebSessionReorderIntent,
  recordWebSessionReorderIntent
} from './web-session-reorder-intent'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '../../../shared/terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'

export async function moveWebRuntimeSessionTab(
  args: RuntimeMobileSessionTabMove & {
    worktreeId: string
    environmentId?: string | null
  }
): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  if (args.kind === 'reorder') {
    // Record local order before async resolution so pre-move snapshots cannot snap it back.
    recordWebSessionReorderIntent(
      intentOwner,
      args.worktreeId,
      args.targetGroupId,
      args.tabOrder,
      Date.now()
    )
  }

  try {
    const { targetGroup, targetHostGroupId, resolveHostBackedTabId } = await hostDropResolvers(
      environmentId,
      args.worktreeId,
      args.tabId,
      args.targetGroupId
    )
    const toHostTabId = (tabId: string): string => resolveHostBackedTabId(tabId) ?? tabId
    const movedHostTabId =
      args.kind === 'reorder' ? resolveHostBackedTabId(args.tabId) : toHostTabId(args.tabId)
    if (!movedHostTabId) {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
      return false
    }
    const reorderedHostTabOrder =
      args.kind === 'reorder'
        ? args.tabOrder
            .map(resolveHostBackedTabId)
            .filter((tabId): tabId is string => Boolean(tabId))
        : null
    if (reorderedHostTabOrder && !reorderedHostTabOrder.includes(movedHostTabId)) {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
      return false
    }
    const targetHostIndex =
      args.kind === 'move-to-group'
        ? hostBackedIndex(targetGroup, args.index, resolveHostBackedTabId)
        : undefined
    const base = {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: movedHostTabId,
      targetGroupId: targetHostGroupId
    }
    const move =
      args.kind === 'reorder'
        ? {
            ...base,
            kind: 'reorder' as const,
            // Host reorder accepts only host tab IDs; omit local-only tabs.
            tabOrder: reorderedHostTabOrder
          }
        : args.kind === 'split'
          ? {
              ...base,
              kind: 'split' as const,
              splitDirection: args.splitDirection
            }
          : {
              ...base,
              kind: 'move-to-group' as const,
              // Host indexes must count only host-backed tabs in mixed web groups.
              index: targetHostIndex
            }
    const response = await callEnvironment({
      method: 'session.tabs.move',
      params: move,
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<RuntimeMobileSessionTabMoveResult>)
    return true
  } catch (error) {
    if (args.kind === 'reorder') {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
    }
    console.warn(
      '[web-runtime-session] failed to move tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

type DesktopGroup = { id: string; tabOrder: string[] }

/** Names a desktop group and its tabs as the host does, for a drop of `movingTabId` into it. */
async function hostDropResolvers(
  environmentId: string,
  worktreeId: string,
  movingTabId: string,
  targetGroupId: string
): Promise<{
  targetGroup: DesktopGroup | undefined
  targetHostGroupId: string
  resolveHostBackedTabId: (tabId: string) => string | null
}> {
  const { resolveHostSessionGroupIdForWebSessionTab, resolveHostSessionTabIdForWebSessionTab } =
    await import('./web-session-tabs-sync/tracking-mappings')
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  const targetGroup = groups.find((group) => group.id === targetGroupId)
  const recordedHostGroupId = (tabId: string): string | null =>
    resolveHostSessionGroupIdForWebSessionTab({ environmentId, worktreeId, tabId })
  // Before the next server list, split-off tabs still carry their source group like outside tabs.
  const hostGroupIdsOutsideTarget = new Set(
    groups
      .filter((group) => group.id !== targetGroupId)
      .flatMap((group) => group.tabOrder)
      .filter((tabId) => tabId !== movingTabId)
      .map(recordedHostGroupId)
  )
  // Name client-split host groups by a contained tab; desktop group IDs differ.
  const targetHostGroupId =
    (targetGroup?.tabOrder ?? [])
      .filter((tabId) => tabId !== movingTabId)
      .map(recordedHostGroupId)
      .find((groupId) => groupId !== null && !hostGroupIdsOutsideTarget.has(groupId)) ??
    // No server-known tab in the target group: the desktop id, unknown to the server, as before.
    targetGroupId
  const resolveHostBackedTabId = (tabId: string): string | null =>
    resolveHostSessionTabIdForWebSessionTab(state, { environmentId, worktreeId, tabId }) ??
    (isWebTerminalSurfaceTabId(tabId) ? toHostSessionTabId(tabId) : null)
  return { targetGroup, targetHostGroupId, resolveHostBackedTabId }
}

// Why: web groups can contain local-only tabs, so host insertion indexes count only the filtered host-backed order.
function hostBackedIndex(
  targetGroup: DesktopGroup | undefined,
  index: number | undefined,
  resolveHostBackedTabId: (tabId: string) => string | null
): number | undefined {
  return typeof index === 'number'
    ? (targetGroup?.tabOrder
        .slice(0, index)
        .map(resolveHostBackedTabId)
        .filter((tabId): tabId is string => Boolean(tabId)).length ?? index)
    : index
}

/** A new tab's drop into a desktop group, named as the host names the group and its position. */
export async function resolveHostTabDropTarget(
  environmentId: string,
  args: { worktreeId: string; tabId: string; targetGroupId: string; index?: number }
): Promise<{ targetGroupId: string; index?: number }> {
  const { targetGroup, targetHostGroupId, resolveHostBackedTabId } = await hostDropResolvers(
    environmentId,
    args.worktreeId,
    args.tabId,
    args.targetGroupId
  )
  const index = hostBackedIndex(targetGroup, args.index, resolveHostBackedTabId)
  return { targetGroupId: targetHostGroupId, ...(index !== undefined ? { index } : {}) }
}
