import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult
} from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  clearWebSessionReorderIntent,
  recordWebSessionReorderIntent
} from './web-session-reorder-intent'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from './web-terminal-surface-id'
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
    // Why: record local order synchronously before async host resolution, so a pre-move snapshot can't snap the tab back.
    recordWebSessionReorderIntent(
      intentOwner,
      args.worktreeId,
      args.targetGroupId,
      args.tabOrder,
      Date.now()
    )
  }

  try {
    const { resolveHostSessionTabIdForWebSessionTab } = await import('./web-session-tabs-sync')
    const state = useAppStore.getState()
    const resolveHostBackedTabId = (tabId: string): string | null =>
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId,
        worktreeId: args.worktreeId,
        tabId
      }) ?? (isWebTerminalSurfaceTabId(tabId) ? toHostSessionTabId(tabId) : null)
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
      args.kind === 'move-to-group' && typeof args.index === 'number'
        ? (state.groupsByWorktree?.[args.worktreeId]
            ?.find((group) => group.id === args.targetGroupId)
            ?.tabOrder.slice(0, args.index)
            .map(resolveHostBackedTabId)
            .filter((tabId): tabId is string => Boolean(tabId)).length ?? args.index)
        : args.kind === 'move-to-group'
          ? args.index
          : undefined
    const base = {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: movedHostTabId,
      targetGroupId: args.targetGroupId
    }
    const move =
      args.kind === 'reorder'
        ? {
            ...base,
            kind: 'reorder' as const,
            // Why: the host reorder API only accepts host tab ids, so local-only tabs must be omitted from the mirrored order.
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
              // Why: web groups can contain local-only tabs, so host insertion indexes count only the filtered host-backed order.
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
