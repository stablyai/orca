import { isLiveChildWork } from './agent-status-child-work-liveness'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type { AgentTurnOutcome } from './agent-turn-outcome'
import { AGENT_DONE_QUIET_MS } from './agent-transitions'

export type AgentFlowNotificationReason = 'input-required' | 'action-required' | 'flow-complete'
export type AgentFlowAlert = {
  flowId: string
  reason: AgentFlowNotificationReason
  alertId: string
}
export type AgentFlowNotificationState = {
  flowId: string
  hostId: string
  rootId: string
  outcome?: AgentTurnOutcome
  parentEnded: boolean
  children?: readonly AgentChildWorkView[]
  inventoryKnown: boolean
  pendingPromptIds: readonly string[]
  owesWork: boolean
  live: boolean
}

export function usesWholeFlowNotifications(mode: unknown, agent: unknown): boolean {
  return mode === 'action-or-flow-complete' && (agent === 'claude' || agent === 'codex')
}

export function agentFlowAlerts(state: AgentFlowNotificationState): AgentFlowAlert[] {
  if (!state.live) {
    return []
  }
  const alert = (reason: AgentFlowNotificationReason, identity = ''): AgentFlowAlert => ({
    flowId: state.flowId,
    reason,
    alertId: ['agent-flow', state.hostId, state.rootId, state.flowId, reason, identity]
      .map(encodeURIComponent)
      .join(':')
  })
  if (state.pendingPromptIds.length) {
    return state.pendingPromptIds.map((id) => alert('input-required', id))
  }
  if (!state.parentEnded || state.owesWork) {
    return []
  }
  if (state.outcome === 'failure') {
    return [alert('action-required')]
  }
  if (state.outcome !== 'success' || !state.inventoryKnown || state.children === undefined) {
    return []
  }
  if (state.children?.some((child) => child.membership !== 'settled' || isLiveChildWork(child))) {
    return []
  }
  return [alert('flow-complete')]
}

/** Own alert timing only; child ownership and lifecycle remain with the existing producers. */
export class AgentFlowNotificationDelivery {
  private readonly announced = new Set<string>()
  private pending: { alertId: string; cancel: () => void } | undefined
  private flowId: string | undefined

  constructor(
    private readonly deps: {
      read: () => AgentFlowNotificationState | null
      deliver: (alert: AgentFlowAlert) => void
      setTimer: (run: () => void, delay: number) => { cancel: () => void }
    }
  ) {}

  observe(seedOnly = false): void {
    const state = this.deps.read()
    if (this.flowId !== state?.flowId) {
      this.cancel()
      this.announced.clear()
      this.flowId = state?.flowId
    }
    const alerts = state ? agentFlowAlerts(state) : []
    if (this.pending && !alerts.some((alert) => alert.alertId === this.pending?.alertId)) {
      this.cancel()
    }
    for (const alert of alerts) {
      if (seedOnly) {
        this.announced.add(alert.alertId)
      } else if (!this.announced.has(alert.alertId)) {
        if (alert.reason !== 'flow-complete') {
          this.deliverCurrent(alert)
        } else if (!this.pending) {
          const timer = this.deps.setTimer(() => {
            this.pending = undefined
            this.deliverCurrent(alert)
          }, AGENT_DONE_QUIET_MS)
          this.pending = { alertId: alert.alertId, cancel: timer.cancel }
        }
      }
    }
    if (seedOnly) {
      this.cancel()
    }
  }

  dispose(): void {
    this.cancel()
    this.announced.clear()
    this.flowId = undefined
  }

  private cancel(): void {
    this.pending?.cancel()
    this.pending = undefined
  }

  private deliverCurrent(alert: AgentFlowAlert): void {
    const state = this.deps.read()
    if (!state || !agentFlowAlerts(state).some((current) => current.alertId === alert.alertId)) {
      return
    }
    this.announced.add(alert.alertId)
    this.deps.deliver(alert)
  }
}
