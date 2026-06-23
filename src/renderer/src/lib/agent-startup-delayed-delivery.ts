import { useAppStore } from '@/store'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { parsePaneKey } from '../../../shared/stable-pane-id'

type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>

type PendingAgentStartupDelivery = {
  worktreeId: string
  tabId: string
  launchToken: string
  startup: AgentStartupPlan
  deliver: (tabId: string, ptyId: string, startup: AgentStartupPlan) => Promise<void>
}

const pendingAgentStartupDeliveries = new Map<string, PendingAgentStartupDelivery>()
const consumedAgentStartupDeliveries = new Set<string>()
const staleStartupRecheckTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>()
let unsubscribePendingAgentStartupDeliveries: (() => void) | null = null

export function resolveAgentStartupTabId(
  state: AppStoreSnapshot,
  worktreeId: string,
  primaryTabId: string | null | undefined
): string | null {
  // Why: the caller may know the exact tab that received the queued startup
  // command. Prefer it over focus-derived state, which can change mid-create.
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

function worktreeStillOwnsStartupTab(
  state: AppStoreSnapshot,
  worktreeId: string,
  tabId: string
): boolean {
  return (state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

function getPendingStartupLaunchToken(state: AppStoreSnapshot, tabId: string): string | undefined {
  return state.pendingStartupByTabId?.[tabId]?.launchToken
}

function hasRegisteredStartupLaunch(
  state: AppStoreSnapshot,
  tabId: string,
  launchToken: string
): boolean {
  return Object.values(state.agentLaunchConfigByPaneKey ?? {}).some(
    (entry) => entry.identity.tabId === tabId && entry.identity.launchToken === launchToken
  )
}

function ensurePendingAgentStartupSubscription(): void {
  if (unsubscribePendingAgentStartupDeliveries) {
    return
  }
  unsubscribePendingAgentStartupDeliveries = useAppStore.subscribe(() => {
    flushPendingAgentStartupDeliveries()
  })
}

function stopPendingAgentStartupSubscriptionIfIdle(): void {
  if (pendingAgentStartupDeliveries.size > 0 || !unsubscribePendingAgentStartupDeliveries) {
    return
  }
  unsubscribePendingAgentStartupDeliveries()
  unsubscribePendingAgentStartupDeliveries = null
}

export function queuePendingAgentStartupDelivery(delivery: PendingAgentStartupDelivery): void {
  const key = deliveryKey(delivery)
  if (consumedAgentStartupDeliveries.has(key)) {
    return
  }
  pendingAgentStartupDeliveries.set(key, delivery)
  ensurePendingAgentStartupSubscription()
  flushPendingAgentStartupDeliveries()
}

export function resetAgentStartupDelayedDeliveryForTests(): void {
  pendingAgentStartupDeliveries.clear()
  consumedAgentStartupDeliveries.clear()
  for (const timer of staleStartupRecheckTimers.values()) {
    globalThis.clearTimeout(timer)
  }
  staleStartupRecheckTimers.clear()
  unsubscribePendingAgentStartupDeliveries?.()
  unsubscribePendingAgentStartupDeliveries = null
}

export function beginAgentStartupDeliveryAttempt(args: {
  worktreeId: string
  tabId: string
  launchToken: string
}): boolean {
  const key = deliveryKey(args)
  if (consumedAgentStartupDeliveries.has(key)) {
    return false
  }
  consumedAgentStartupDeliveries.add(key)
  pendingAgentStartupDeliveries.delete(key)
  clearStaleStartupRecheck(key)
  return true
}

function deliveryKey(
  delivery: Pick<PendingAgentStartupDelivery, 'worktreeId' | 'tabId' | 'launchToken'>
): string {
  return `${delivery.worktreeId}\0${delivery.tabId}\0${delivery.launchToken}`
}

function flushPendingAgentStartupDeliveries(): void {
  const state = useAppStore.getState()
  for (const [key, delivery] of pendingAgentStartupDeliveries) {
    const { tabId, launchToken } = delivery
    if (!worktreeStillOwnsStartupTab(state, delivery.worktreeId, tabId)) {
      pendingAgentStartupDeliveries.delete(key)
      continue
    }
    const queuedLaunchToken = getPendingStartupLaunchToken(state, tabId)
    const launchRegistered = hasRegisteredStartupLaunch(state, tabId, launchToken)
    if (queuedLaunchToken !== launchToken && !launchRegistered && queuedLaunchToken !== undefined) {
      pendingAgentStartupDeliveries.delete(key)
      clearStaleStartupRecheck(key)
      continue
    }
    if (queuedLaunchToken === undefined && !launchRegistered) {
      scheduleStaleStartupRecheck(key)
      continue
    }
    const ptyId = getAgentStartupTabPtyId(state, tabId, launchToken)
    if (!ptyId) {
      continue
    }
    // Why: once the launch-bound PTY exists, the bounded readiness/paste path
    // owns success or failure. Consume before awaiting so store churn cannot
    // duplicate a linked-work-item draft.
    if (beginAgentStartupDeliveryAttempt(delivery)) {
      void delivery.deliver(tabId, ptyId, delivery.startup).catch((error) => {
        console.warn('Queued agent startup delivery failed', error)
      })
    }
  }
  stopPendingAgentStartupSubscriptionIfIdle()
}

function scheduleStaleStartupRecheck(key: string): void {
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

function clearStaleStartupRecheck(key: string): void {
  const timer = staleStartupRecheckTimers.get(key)
  if (!timer) {
    return
  }
  globalThis.clearTimeout(timer)
  staleStartupRecheckTimers.delete(key)
}
