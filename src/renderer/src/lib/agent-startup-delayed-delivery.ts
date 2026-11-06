import {
  deliverLaunchPromptToAgentTab,
  notifyAgentLaunchPromptNotSent
} from './agent-launch-prompt-delivery'
import { useAppStore } from '@/store'
import { onRuntimeEnvironmentsRetired } from '@/runtime/runtime-environment-revision'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from '@/components/terminal-pane/remote-runtime-pty-recovery-limits'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { settleAgentLaunchPromptFailure } from './agent-launch-prompt-delivery'
import {
  getAgentStartupTabPtyId,
  worktreeStillOwnsStartupTab,
  getPendingStartupLaunchToken,
  hasRegisteredStartupLaunch,
  subscribeAgentStartupBindings,
  scheduleStaleStartupRecheck
} from './agent-startup-tab-binding'
export { resolveAgentStartupTabId, getAgentStartupTabPtyId } from './agent-startup-tab-binding'
import {
  agentStartupDeliveryKey as deliveryKey,
  clearConsumedAgentStartupDeliveriesForTests,
  isAgentStartupDeliveryConsumed,
  markAgentStartupDeliveryConsumed,
  releaseAgentStartupDeliveryConsumed,
  pendingAgentStartupDeliveries,
  type DeliveryIdentity,
  type PendingAgentStartupDelivery,
  type PendingHostedPrompt,
  type PromptBinding
} from './agent-startup-delivery-guards'

const staleStartupRecheckTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>()
let unsubscribePendingAgentStartupDeliveries: (() => void) | null = null
let unsubscribeHostRetirement: (() => void) | null = null

function ensurePendingAgentStartupSubscription(): void {
  if (unsubscribePendingAgentStartupDeliveries) {
    return
  }
  unsubscribeHostRetirement = onRuntimeEnvironmentsRetired((ids) => {
    for (const delivery of pendingAgentStartupDeliveries.values()) {
      if ('prompt' in delivery && ids.includes(delivery.environmentId)) {
        settleHostedPrompt(delivery, true)
      }
    }
  })
  unsubscribePendingAgentStartupDeliveries = subscribeAgentStartupBindings(
    flushPendingAgentStartupDeliveries
  )
}

function stopPendingAgentStartupSubscriptionIfIdle(): void {
  if (pendingAgentStartupDeliveries.size > 0 || !unsubscribePendingAgentStartupDeliveries) {
    return
  }
  unsubscribePendingAgentStartupDeliveries()
  unsubscribePendingAgentStartupDeliveries = null
  unsubscribeHostRetirement?.()
  unsubscribeHostRetirement = null
}

export function queuePendingAgentStartupDelivery(delivery: PendingAgentStartupDelivery): void {
  const key = deliveryKey(delivery)
  if (isAgentStartupDeliveryConsumed(key)) {
    return
  }
  delivery.retire = () => {
    pendingAgentStartupDeliveries.delete(key)
    clearStaleStartupRecheck(key)
    stopPendingAgentStartupSubscriptionIfIdle()
  }
  pendingAgentStartupDeliveries.set(key, delivery)
  ensurePendingAgentStartupSubscription()
  flushPendingAgentStartupDeliveries()
}

/** Readiness retains ownership; only the first actual PTY write consumes this launch. */
export function deliverPendingAgentStartupPrompt(
  args: DeliveryIdentity & {
    environmentId: string
    prompt: PendingHostedPrompt['prompt']
    binding: PromptBinding
  }
): Promise<boolean> {
  const key = deliveryKey(args)
  if (isAgentStartupDeliveryConsumed(key)) {
    return Promise.resolve(false)
  }
  const pending = pendingAgentStartupDeliveries.get(key)
  const delivery: PendingHostedPrompt = pending && 'prompt' in pending ? pending : args
  if (pending && 'prompt' in pending && pending.binding.ptyId !== args.binding.ptyId) {
    return Promise.resolve(false)
  }
  delivery.binding = args.binding
  pendingAgentStartupDeliveries.set(key, delivery)
  if (!pending) {
    delivery.registrationPaneKey = Object.entries(
      useAppStore.getState().agentLaunchConfigByPaneKey
    ).find(
      ([, entry]) =>
        entry.identity.tabId === delivery.tabId &&
        entry.identity.launchToken === delivery.launchToken
    )?.[0]
    delivery.retire = () => settleHostedPrompt(delivery, false)
    staleStartupRecheckTimers.set(
      key,
      globalThis.setTimeout(
        () => settleHostedPrompt(delivery, true),
        REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS +
          resolveDraftPasteReadyTimeoutMs(delivery.prompt.agent)
      )
    )
  }
  ensurePendingAgentStartupSubscription()
  return attemptPendingHostedPrompt(delivery)
}

/** Rebind the same unattempted launch after reconnect or pane replacement. */
export function rebindPendingAgentStartupPrompt(args: DeliveryIdentity & PromptBinding): void {
  const delivery = pendingAgentStartupDeliveries.get(deliveryKey(args))
  if (
    !delivery ||
    !('prompt' in delivery) ||
    delivery.binding.ptyId !== args.ptyId ||
    isAgentStartupDeliveryConsumed(deliveryKey(args))
  ) {
    return
  }
  if (
    delivery.running &&
    delivery.binding.ptyId === args.ptyId &&
    delivery.binding.beforePaste?.() !== false
  ) {
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
    onDeliveryFailure: () => {
      if (isAgentStartupDeliveryConsumed(key)) {
        settleHostedPrompt(delivery, true)
      }
    },
    tabId: delivery.tabId,
    beforePaste: () =>
      pendingAgentStartupDeliveries.get(key) === delivery &&
      delivery.binding === binding &&
      binding.beforePaste?.() !== false,
    ...(binding.ptyId ? { launchPty: Promise.resolve(binding.ptyId) } : {}),
    claimFirstWrite: () => {
      if (
        pendingAgentStartupDeliveries.get(key) !== delivery ||
        isAgentStartupDeliveryConsumed(key)
      ) {
        return false
      }
      markAgentStartupDeliveryConsumed(key)
      return true
    }
  })
    .catch(() => false)
    .then((delivered) => {
      if (pendingAgentStartupDeliveries.get(key) !== delivery) {
        return false
      }
      if (delivered || isAgentStartupDeliveryConsumed(key)) {
        settleHostedPrompt(delivery, !delivered)
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

function settleHostedPrompt(delivery: PendingHostedPrompt, failed: boolean): void {
  const key = deliveryKey(delivery)
  if (pendingAgentStartupDeliveries.get(key) !== delivery) {
    return
  }
  pendingAgentStartupDeliveries.delete(key)
  clearStaleStartupRecheck(key)
  markAgentStartupDeliveryConsumed(key)
  stopPendingAgentStartupSubscriptionIfIdle()
  if (failed) {
    settleAgentLaunchPromptFailure({ ...delivery.prompt, tabId: delivery.tabId })
    notifyAgentLaunchPromptNotSent(delivery.prompt.agent, delivery.prompt.content)
  }
}

export function retireAgentStartupPromptForTerminal(ptyId: string): void {
  for (const delivery of pendingAgentStartupDeliveries.values()) {
    if ('prompt' in delivery && delivery.binding.ptyId === ptyId) {
      settleHostedPrompt(delivery, true)
    }
  }
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
  unsubscribeHostRetirement?.()
  unsubscribeHostRetirement = null
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
    if ('prompt' in delivery) {
      const queued = getPendingStartupLaunchToken(state, tabId)
      const registration = delivery.registrationPaneKey
        ? state.agentLaunchConfigByPaneKey[delivery.registrationPaneKey]
        : undefined
      if (
        (queued && queued !== launchToken) ||
        (registration?.identity.launchToken && registration.identity.launchToken !== launchToken)
      ) {
        settleHostedPrompt(delivery, false)
      }
      continue
    }
    if (!worktreeStillOwnsStartupTab(state, delivery.worktreeId, tabId)) {
      pendingAgentStartupDeliveries.delete(key)
      clearStaleStartupRecheck(key)
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
      scheduleStaleStartupRecheck(
        key,
        staleStartupRecheckTimers,
        flushPendingAgentStartupDeliveries,
        stopPendingAgentStartupSubscriptionIfIdle
      )
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

function clearStaleStartupRecheck(key: string): void {
  const timer = staleStartupRecheckTimers.get(key)
  if (timer === undefined) {
    return
  }
  globalThis.clearTimeout(timer)
  staleStartupRecheckTimers.delete(key)
}
