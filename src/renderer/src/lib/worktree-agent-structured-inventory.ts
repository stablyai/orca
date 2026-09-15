import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  runtimeTargetForActivationRoute,
  type WorktreeAgentActivationRoute
} from './worktree-agent-activation-route'

export type StructuredActivationInventory = {
  snapshot: RuntimeMobileSessionTabsResult
  ownerBySessionId: ReadonlyMap<
    string,
    {
      owner: 'native' | 'tui'
      terminal?: { paneKey: string; ptyId: string; tabId: string }
    }
  >
}

export async function readWorktreeStructuredActivationInventory(
  routeOrWorktreeId: WorktreeAgentActivationRoute | string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<false | StructuredActivationInventory> {
  if (typeof window === 'undefined') {
    return false
  }
  const route = typeof routeOrWorktreeId === 'string' ? null : routeOrWorktreeId
  const worktreeId =
    typeof routeOrWorktreeId === 'string' ? routeOrWorktreeId : routeOrWorktreeId.workspaceKey
  const target = route ? runtimeTargetForActivationRoute(route) : { kind: 'local' as const }
  if (!target) {
    throw new Error('structured session inventory route unavailable')
  }
  let snapshot: RuntimeMobileSessionTabsResult
  try {
    snapshot = await callRuntimeRpc<RuntimeMobileSessionTabsResult>(
      target,
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      {
        ...options,
        ...(route?.runtimeEnvironmentRevision === null || route === null
          ? {}
          : { expectedEnvironmentPairingRevision: route.runtimeEnvironmentRevision })
      }
    )
  } catch {
    throw new Error('structured session inventory unavailable')
  }
  if (
    !snapshot ||
    typeof snapshot.worktree !== 'string' ||
    !worktreeIdsEqual(snapshot.worktree, worktreeId) ||
    !Array.isArray(snapshot.tabs)
  ) {
    throw new Error('structured session inventory scope unavailable')
  }
  if (!snapshot.tabs.some((tab) => tab.type === 'agent-session')) {
    return false
  }
  const ownerBySessionId = new Map<
    string,
    {
      owner: 'native' | 'tui'
      terminal?: { paneKey: string; ptyId: string; tabId: string }
    }
  >()
  await Promise.all(
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session'
        ? [
            callRuntimeRpc<{
              owner?: unknown
              terminal?: { paneKey?: unknown; ptyId?: unknown; tabId?: unknown }
            }>(
              target,
              'agentSession.handoffStatus',
              { sessionId: tab.sessionId },
              {
                ...options,
                ...(route?.runtimeEnvironmentRevision === null || route === null
                  ? {}
                  : { expectedEnvironmentPairingRevision: route.runtimeEnvironmentRevision })
              }
            ).then((status) => {
              const typedStatus: {
                owner?: unknown
                terminal?: { paneKey?: unknown; ptyId?: unknown; tabId?: unknown }
              } = status
              if (typedStatus.owner === 'native') {
                ownerBySessionId.set(tab.sessionId, { owner: 'native' })
              } else if (
                typedStatus.owner === 'tui' &&
                typeof typedStatus.terminal?.paneKey === 'string' &&
                typeof typedStatus.terminal?.ptyId === 'string' &&
                typedStatus.terminal.ptyId.length > 0 &&
                typeof typedStatus.terminal.tabId === 'string'
              ) {
                ownerBySessionId.set(tab.sessionId, {
                  owner: 'tui',
                  terminal: {
                    paneKey: typedStatus.terminal.paneKey,
                    ptyId: typedStatus.terminal.ptyId,
                    tabId: typedStatus.terminal.tabId
                  }
                })
              }
            })
          ]
        : []
    )
  )
  return { snapshot, ownerBySessionId }
}
