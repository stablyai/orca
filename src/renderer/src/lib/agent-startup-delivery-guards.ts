import type { AgentStartupPlan } from '../../../shared/agent-launch/startup/tui-agent-startup'
import type { deliverLaunchPromptToAgentTab } from './agent-launch-prompt-delivery'

export type DeliveryIdentity = {
  worktreeId: string
  tabId: string
  launchToken: string
}

export type PendingAgentStartupDelivery = {
  worktreeId: string
  tabId: string
  launchToken: string
  retire?: () => void
  startup: AgentStartupPlan
  deliver: (tabId: string, ptyId: string, startup: AgentStartupPlan) => Promise<void>
}

export type PromptBinding = { ptyId?: string; beforePaste?: () => boolean }
export type PendingHostedPrompt = DeliveryIdentity & {
  environmentId: string
  registrationPaneKey?: string
  retire?: () => void
  prompt: Omit<
    Parameters<typeof deliverLaunchPromptToAgentTab>[0],
    'tabId' | 'launchPty' | 'beforePaste' | 'claimFirstWrite'
  >
  binding: PromptBinding
  attemptedBinding?: PromptBinding
  running?: Promise<boolean>
}

export const pendingAgentStartupDeliveries = new Map<
  string,
  PendingAgentStartupDelivery | PendingHostedPrompt
>()

// Keep consumed guards store-free so tab/worktree teardown can purge them without a delayed-delivery/store import cycle.

export function agentStartupDeliveryKey(delivery: {
  worktreeId: string
  tabId: string
  launchToken: string
}): string {
  return `${delivery.worktreeId}\0${delivery.tabId}\0${delivery.launchToken}`
}

const consumedAgentStartupDeliveries = new Set<string>()

export function isAgentStartupDeliveryConsumed(key: string): boolean {
  return consumedAgentStartupDeliveries.has(key)
}

export function markAgentStartupDeliveryConsumed(key: string): void {
  consumedAgentStartupDeliveries.add(key)
}

export function releaseAgentStartupDeliveryConsumed(key: string): void {
  consumedAgentStartupDeliveries.delete(key)
}

export function clearConsumedAgentStartupDeliveriesForTests(): void {
  consumedAgentStartupDeliveries.clear()
}

// Successful guards persist until teardown; purge removed tabs/worktrees to bound session-long accumulation.
export function forgetAgentStartupDeliveriesForTabs(tabIds: Iterable<string>): void {
  const tabIdSet = tabIds instanceof Set ? tabIds : new Set(tabIds)
  if (tabIdSet.size === 0) {
    return
  }
  for (const delivery of pendingAgentStartupDeliveries.values()) {
    if (tabIdSet.has(delivery.tabId)) {
      delivery.retire?.()
    }
  }
  for (const key of consumedAgentStartupDeliveries) {
    // agentStartupDeliveryKey() is `${worktreeId}\0${tabId}\0${launchToken}`.
    const tabId = key.split('\0')[1] ?? ''
    if (tabIdSet.has(tabId)) {
      consumedAgentStartupDeliveries.delete(key)
    }
  }
}

export function forgetAgentStartupDeliveriesForWorktrees(worktreeIds: Iterable<string>): void {
  const ids = new Set(worktreeIds)
  for (const delivery of pendingAgentStartupDeliveries.values()) {
    if (ids.has(delivery.worktreeId)) {
      delivery.retire?.()
    }
  }
  for (const key of consumedAgentStartupDeliveries) {
    if (ids.has(key.split('\0')[0])) {
      consumedAgentStartupDeliveries.delete(key)
    }
  }
}
