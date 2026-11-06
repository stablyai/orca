import {
  deliverLaunchPromptToAgentTab,
  notifyAgentLaunchPromptNotSent
} from './agent-launch-prompt-delivery'
import { useAppStore } from '@/store'
import type { AgentStartupPlan } from '../../../shared/agent-launch/startup/tui-agent-startup'
import {
  getAgentStartupTabPtyId,
  worktreeStillOwnsStartupTab,
  getPendingStartupLaunchToken,
  hasRegisteredStartupLaunch
} from './agent-startup-tab-binding'
export { resolveAgentStartupTabId, getAgentStartupTabPtyId } from './agent-startup-tab-binding'
import {
  agentStartupDeliveryKey as deliveryKey,
  clearConsumedAgentStartupDeliveriesForTests,
  isAgentStartupDeliveryConsumed,
  markAgentStartupDeliveryConsumed,
  releaseAgentStartupDeliveryConsumed
} from './agent-startup-delivery-guards'

type DeliveryIdentity = {
  worktreeId: string
  tabId: string
  launchToken: string
}

type PendingAgentStartupDelivery = {
  worktreeId: string
  tabId: string
  launchToken: string
  startup: AgentStartupPlan
  deliver: (tabId: string, ptyId: string, startup: AgentStartupPlan) => Promise<void>
}

type PromptBinding = { ptyId?: string; beforePaste?: () => boolean }
type PendingHostedPrompt = DeliveryIdentity & {
  prompt: Omit<
    Parameters<typeof deliverLaunchPromptToAgentTab>[0],
    'tabId' | 'launchPty' | 'beforePaste' | 'claimFirstWrite'
  >
  binding: PromptBinding
  attemptedBinding?: PromptBinding
  running?: Promise<boolean>
  tabObserved?: boolean
  failureNotified?: boolean
}

const pendingAgentStartupDeliveries = new Map<
  string,
  PendingAgentStartupDelivery | PendingHostedPrompt
>()
const staleStartupRecheckTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>()
let unsubscribePendingAgentStartupDeliveries: (() => void) | null = null

function ensurePendingAgentStartupSubscription(): void {
  if (unsubscribePendingAgentStartupDeliveries) {
    return
  }
  const initial = useAppStore.getState()
  // Capture references individually to avoid allocation and support subscribe adapters that reuse state objects.
  let previousTabs = initial.tabsByWorktree
  let previousPendingStartups = initial.pendingStartupByTabId
  let previousLaunchConfigs = initial.agentLaunchConfigByPaneKey
  let previousPtyIds = initial.ptyIdsByTabId
  let previousLayouts = initial.terminalLayoutsByTabId
  unsubscribePendingAgentStartupDeliveries = useAppStore.subscribe((state) => {
    // Only five immutable slices affect delivery; title/status/focus/usage churn must not rescan indefinitely unmounted launches.
    if (
      state.tabsByWorktree === previousTabs &&
      state.pendingStartupByTabId === previousPendingStartups &&
      state.agentLaunchConfigByPaneKey === previousLaunchConfigs &&
      state.ptyIdsByTabId === previousPtyIds &&
      state.terminalLayoutsByTabId === previousLayouts
    ) {
      return
    }
    // Update before flushing because delivery can synchronously write the store.
    previousTabs = state.tabsByWorktree
    previousPendingStartups = state.pendingStartupByTabId
    previousLaunchConfigs = state.agentLaunchConfigByPaneKey
    previousPtyIds = state.ptyIdsByTabId
    previousLayouts = state.terminalLayoutsByTabId
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
  if (isAgentStartupDeliveryConsumed(key)) {
    return
  }
  pendingAgentStartupDeliveries.set(key, delivery)
  ensurePendingAgentStartupSubscription()
  flushPendingAgentStartupDeliveries()
}

/** Readiness retains ownership; only the first actual PTY write consumes this launch. */
export function deliverPendingAgentStartupPrompt(
  args: DeliveryIdentity & { prompt: PendingHostedPrompt['prompt']; binding: PromptBinding }
): Promise<boolean> {
  const key = deliveryKey(args)
  if (isAgentStartupDeliveryConsumed(key)) {
    return Promise.resolve(false)
  }
  const pending = pendingAgentStartupDeliveries.get(key)
  const delivery: PendingHostedPrompt = pending && 'prompt' in pending ? pending : args
  delivery.binding = args.binding
  delivery.tabObserved ||= worktreeStillOwnsStartupTab(
    useAppStore.getState(),
    delivery.worktreeId,
    delivery.tabId
  )
  pendingAgentStartupDeliveries.set(key, delivery)
  ensurePendingAgentStartupSubscription()
  return attemptPendingHostedPrompt(delivery)
}

/** Rebind the same unattempted launch after reconnect or pane replacement. */
export function rebindPendingAgentStartupPrompt(args: DeliveryIdentity & PromptBinding): void {
  const delivery = pendingAgentStartupDeliveries.get(deliveryKey(args))
  if (!delivery || !('prompt' in delivery) || isAgentStartupDeliveryConsumed(deliveryKey(args))) {
    return
  }
  if (delivery.running && delivery.binding.ptyId === args.ptyId) {
    delivery.binding.beforePaste = args.beforePaste
    return
  }
  delivery.binding = { ptyId: args.ptyId, beforePaste: args.beforePaste }
  void attemptPendingHostedPrompt(delivery)
}

function attemptPendingHostedPrompt(delivery: PendingHostedPrompt): Promise<boolean> {
  if (delivery.running) {
    return delivery.running
  }
  const binding = delivery.binding
  if (delivery.attemptedBinding === binding) {
    return Promise.resolve(false)
  }
  delivery.attemptedBinding = binding
  const key = deliveryKey(delivery)
  delivery.running = deliverLaunchPromptToAgentTab({
    ...delivery.prompt,
    tabId: delivery.tabId,
    beforePaste: () =>
      pendingAgentStartupDeliveries.get(key) === delivery &&
      delivery.binding === binding &&
      binding.beforePaste?.() !== false,
    ...(binding.ptyId ? { launchPty: Promise.resolve(binding.ptyId) } : {}),
    claimFirstWrite: () => {
      if (!beginAgentStartupDeliveryAttempt(delivery)) {
        return false
      }
      pendingAgentStartupDeliveries.set(key, delivery)
      return true
    }
  })
    .catch(() => false)
    .then((delivered) => {
      if (pendingAgentStartupDeliveries.get(key) !== delivery) {
        return false
      }
      if (delivered) {
        pendingAgentStartupDeliveries.delete(key)
      } else {
        // A failed/unknown write stays consumed; retained text may only be resumed if no write was attempted.
        pendingAgentStartupDeliveries.set(key, delivery)
        if (!delivery.failureNotified) {
          delivery.failureNotified = true
          notifyAgentLaunchPromptNotSent(delivery.prompt.agent)
        }
      }
      return delivered
    })
    .finally(() => {
      delivery.running = undefined
      if (
        pendingAgentStartupDeliveries.get(key) === delivery &&
        !isAgentStartupDeliveryConsumed(key) &&
        delivery.binding !== binding
      ) {
        void attemptPendingHostedPrompt(delivery)
      }
      stopPendingAgentStartupSubscriptionIfIdle()
    })
  return delivery.running
}

export function resetAgentStartupDelayedDeliveryForTests(): void {
  pendingAgentStartupDeliveries.clear()
  clearConsumedAgentStartupDeliveriesForTests()
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
  if (isAgentStartupDeliveryConsumed(key)) {
    return false
  }
  markAgentStartupDeliveryConsumed(key)
  pendingAgentStartupDeliveries.delete(key)
  clearStaleStartupRecheck(key)
  return true
}

export function releaseAgentStartupDeliveryAttempt(args: {
  worktreeId: string
  tabId: string
  launchToken: string
}): void {
  releaseAgentStartupDeliveryConsumed(deliveryKey(args))
}

function flushPendingAgentStartupDeliveries(): void {
  const state = useAppStore.getState()
  for (const [key, delivery] of pendingAgentStartupDeliveries) {
    const { tabId, launchToken } = delivery
    if (!worktreeStillOwnsStartupTab(state, delivery.worktreeId, tabId)) {
      if ('prompt' in delivery && !delivery.tabObserved) {
        continue
      }
      pendingAgentStartupDeliveries.delete(key)
      continue
    }
    if ('prompt' in delivery) {
      delivery.tabObserved = true
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
    // Consume before awaiting bounded readiness/paste so store churn cannot deliver the linked-work-item draft twice.
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

function clearStaleStartupRecheck(key: string): void {
  const timer = staleStartupRecheckTimers.get(key)
  if (!timer) {
    return
  }
  globalThis.clearTimeout(timer)
  staleStartupRecheckTimers.delete(key)
}
