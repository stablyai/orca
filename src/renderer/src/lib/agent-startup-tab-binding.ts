import { pendingAgentStartupDeliveries } from './agent-startup-delivery-guards'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>

export function resolveAgentStartupTabId(
  state: AppStoreSnapshot,
  worktreeId: string,
  primaryTabId: string | null | undefined
): string | null {
  // Prefer the caller’s exact startup tab; focus can change during creation.
  return (
    primaryTabId ??
    state.activeTabIdByWorktree[worktreeId] ??
    state.tabsByWorktree[worktreeId]?.[0]?.id ??
    null
  )
}

export function getAgentStartupTabPtyId(
  state: AppStoreSnapshot,
  tabId: string,
  launchToken: string
): string | null {
  const livePtyIds = new Set(state.ptyIdsByTabId[tabId] ?? [])
  if (livePtyIds.size === 0) {
    return null
  }
  for (const [paneKey, entry] of Object.entries(state.agentLaunchConfigByPaneKey ?? {})) {
    const identity = entry.identity
    if (identity.tabId !== tabId || identity.launchToken !== launchToken) {
      continue
    }
    const leafId = identity.leafId ?? parsePaneKey(paneKey)?.leafId
    if (!leafId) {
      continue
    }
    const ptyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
    if (ptyId && livePtyIds.has(ptyId)) {
      return ptyId
    }
  }
  return null
}

export function worktreeStillOwnsStartupTab(
  state: AppStoreSnapshot,
  worktreeId: string,
  tabId: string
): boolean {
  return (state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

export function getPendingStartupLaunchToken(
  state: AppStoreSnapshot,
  tabId: string
): string | undefined {
  return state.pendingStartupByTabId?.[tabId]?.launchToken
}

export function hasRegisteredStartupLaunch(
  state: AppStoreSnapshot,
  tabId: string,
  launchToken: string
): boolean {
  return Object.values(state.agentLaunchConfigByPaneKey ?? {}).some(
    (entry) => entry.identity.tabId === tabId && entry.identity.launchToken === launchToken
  )
}

/** Only a concrete binding to the registered terminal may recover a consumed startup's identity. */
export function registeredAgentStartupLaunchToken(
  state: AppStoreSnapshot,
  tabId: string,
  leafId: string | undefined,
  ptyId: string
): string | undefined {
  if (!leafId) {
    return undefined
  }
  const entry = state.agentLaunchConfigByPaneKey[`${tabId}:${leafId}`]
  return entry?.identity.tabId === tabId &&
    entry.identity.leafId === leafId &&
    entry.identity.terminalHandle === (parseRemoteRuntimePtyId(ptyId)?.handle ?? ptyId)
    ? entry.identity.launchToken
    : undefined
}

export function subscribeAgentStartupBindings(flush: () => void): () => void {
  const initial = useAppStore.getState()
  let tabs = initial.tabsByWorktree
  let pending = initial.pendingStartupByTabId
  let configs = initial.agentLaunchConfigByPaneKey
  let ptys = initial.ptyIdsByTabId
  let layouts = initial.terminalLayoutsByTabId
  return useAppStore.subscribe((state) => {
    if (
      state.tabsByWorktree === tabs &&
      state.pendingStartupByTabId === pending &&
      state.agentLaunchConfigByPaneKey === configs &&
      state.ptyIdsByTabId === ptys &&
      state.terminalLayoutsByTabId === layouts
    ) {
      return
    }
    tabs = state.tabsByWorktree
    pending = state.pendingStartupByTabId
    configs = state.agentLaunchConfigByPaneKey
    ptys = state.ptyIdsByTabId
    layouts = state.terminalLayoutsByTabId
    flush()
  })
}

export function registerAgentStartupTerminalBinding(args: {
  tabId: string
  leafId?: string
  ptyId: string
  launchToken: string
  agent?: NonNullable<Parameters<AppStoreSnapshot['registerAgentLaunchConfig']>[2]>['agentType']
  launchConfig?: Parameters<AppStoreSnapshot['registerAgentLaunchConfig']>[1]
}): void {
  if (!args.leafId) {
    return
  }
  const state = useAppStore.getState()
  const paneKey = `${args.tabId}:${args.leafId}`
  const registered = state.agentLaunchConfigByPaneKey[paneKey]
  const terminalHandle = parseRemoteRuntimePtyId(args.ptyId)?.handle ?? args.ptyId
  if (
    registered?.identity.launchToken === args.launchToken &&
    registered.identity.terminalHandle === terminalHandle
  ) {
    return
  }
  state.registerAgentLaunchConfig(
    paneKey,
    args.launchConfig ?? registered?.launchConfig ?? { agentArgs: '', agentEnv: {} },
    {
      tabId: args.tabId,
      leafId: args.leafId,
      launchToken: args.launchToken,
      terminalHandle,
      agentType: args.agent
    }
  )
}

export function scheduleStaleStartupRecheck(
  key: string,
  staleStartupRecheckTimers: Map<string, ReturnType<typeof globalThis.setTimeout>>,
  flushPendingAgentStartupDeliveries: () => void,
  stopPendingAgentStartupSubscriptionIfIdle: () => void
): void {
  if (staleStartupRecheckTimers.has(key)) {
    return
  }
  staleStartupRecheckTimers.set(
    key,
    globalThis.setTimeout(() => {
      staleStartupRecheckTimers.delete(key)
      const delivery = pendingAgentStartupDeliveries.get(key)
      if (!delivery) {
        stopPendingAgentStartupSubscriptionIfIdle()
        return
      }
      const state = useAppStore.getState()
      if ('prompt' in delivery) {
        flushPendingAgentStartupDeliveries()
        return
      }
      const queuedLaunchToken = getPendingStartupLaunchToken(state, delivery.tabId)
      if (
        queuedLaunchToken === undefined &&
        !hasRegisteredStartupLaunch(state, delivery.tabId, delivery.launchToken)
      ) {
        pendingAgentStartupDeliveries.delete(key)
      } else {
        flushPendingAgentStartupDeliveries()
      }
      stopPendingAgentStartupSubscriptionIfIdle()
    }, 1000)
  )
}
