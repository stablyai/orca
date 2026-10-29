import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import {
  AgentFlowNotificationDelivery,
  usesWholeFlowNotifications,
  type AgentFlowAlert,
  type AgentFlowNotificationState
} from './agent-flow-notification-policy'

const child = (
  state: AgentChildWorkView['state'],
  membership: AgentChildWorkView['membership'] = 'live'
): AgentChildWorkView => ({
  id: 'build',
  kind: 'command',
  state,
  membership,
  invocation: { invocationId: 'build-1', generation: 1 },
  firstObservedAt: 1,
  observedAt: 2,
  stoppable: true
})
function harness(initial: Partial<AgentFlowNotificationState> = {}) {
  vi.useFakeTimers()
  let state: AgentFlowNotificationState | null = {
    hostId: 'host-1',
    rootId: 'root-1',
    flowId: 'request-1',
    parentEnded: false,
    children: [],
    inventoryKnown: true,
    pendingPromptIds: [],
    owesWork: false,
    live: true,
    ...initial
  }
  const alerts: AgentFlowAlert[] = []
  const delivery = new AgentFlowNotificationDelivery({
    read: () => state,
    deliver: (alert) => alerts.push(alert),
    setTimer: (run, delay) => {
      const timer = setTimeout(run, delay)
      return { cancel: () => clearTimeout(timer) }
    }
  })
  return {
    delivery,
    alerts,
    update: (patch: Partial<AgentFlowNotificationState>) => {
      if (state) {
        state = { ...state, ...patch }
      }
      delivery.observe()
    },
    disconnect: () => {
      state = null
    },
    tick: (ms = 1500) => vi.advanceTimersByTime(ms)
  }
}
afterEach(() => vi.useRealTimers())

describe('flow notification lifecycle', () => {
  it.each(['claude', 'codex'])('keeps %s opt-in and leaves other providers alone', (agent) => {
    expect(usesWholeFlowNotifications('action-or-flow-complete', agent)).toBe(true)
    expect(usesWholeFlowNotifications('current', agent)).toBe(false)
    expect(usesWholeFlowNotifications(undefined, agent)).toBe(false)
    expect(usesWholeFlowNotifications('action-or-flow-complete', 'pi')).toBe(false)
  })
  it('waits for background work, owed wake-up and continuation, then delivers once after quiet', () => {
    const h = harness()
    h.update({ parentEnded: true, outcome: 'success', children: [child('monitoring')] })
    h.tick(5000)
    expect(h.alerts).toEqual([])
    h.update({ children: [child('done', 'settled')], owesWork: true })
    h.tick()
    h.update({ parentEnded: false, owesWork: false })
    h.tick()
    expect(h.alerts).toEqual([])
    h.update({ parentEnded: true, outcome: 'success' })
    h.tick(1499)
    expect(h.alerts).toEqual([])
    h.tick(1)
    h.update({})
    h.tick()
    expect(h.alerts.map((alert) => alert.reason)).toEqual(['flow-complete'])
  })
  it('announces distinct unresolved prompts while siblings work, deduping replay and resolution', () => {
    const h = harness({ children: [child('working')] })
    h.update({ pendingPromptIds: ['question-a'] })
    h.update({ pendingPromptIds: ['question-a'] })
    h.update({ pendingPromptIds: ['question-a', 'question-b'] })
    h.update({ pendingPromptIds: [] })
    h.tick()
    expect(h.alerts.map((alert) => alert.reason)).toEqual(['input-required', 'input-required'])
    expect(new Set(h.alerts.map((alert) => alert.alertId)).size).toBe(2)
  })
  it.each(['cancellation', 'superseded', 'interruption', 'unconfirmed', undefined] as const)(
    'never announces %s as success',
    (outcome) => {
      const h = harness()
      h.update({ parentEnded: true, outcome })
      h.tick()
      expect(h.alerts).toEqual([])
    }
  )
  it('does not announce recoverable errors, but announces a blocking parent failure once', () => {
    const h = harness()
    h.update({ children: [child('blocked')], outcome: 'failure' })
    expect(h.alerts).toEqual([])
    h.update({ parentEnded: true, children: [] })
    h.update({})
    expect(h.alerts.map((alert) => alert.reason)).toEqual(['action-required'])
  })
  it('revalidates current state and flow identity at delivery even without another observation', () => {
    const h = harness()
    h.update({ parentEnded: true, outcome: 'success' })
    h.disconnect()
    h.tick()
    expect(h.alerts).toEqual([])
  })
  it('cancels completion on renewed work, supersession, unknown inventory, and retirement', () => {
    const h = harness()
    h.update({ parentEnded: true, outcome: 'success' })
    h.tick(1000)
    h.update({ flowId: 'request-2', parentEnded: false })
    h.tick()
    h.update({ parentEnded: true, inventoryKnown: false })
    h.tick()
    expect(h.alerts).toEqual([])
    h.update({ inventoryKnown: true })
    h.delivery.dispose()
    h.tick()
    expect(h.alerts).toEqual([])
  })
  it('silently seeds already finished work and unresolved historical prompts', () => {
    const h = harness({ parentEnded: true, outcome: 'success' })
    h.delivery.observe(true)
    h.update({})
    h.tick()
    expect(h.alerts).toEqual([])
    const restored = harness({ pendingPromptIds: ['restored'] })
    restored.delivery.observe(true)
    restored.update({})
    expect(restored.alerts).toEqual([])
  })
  it('keeps nested live descendants active even under a settled ancestor', () => {
    const h = harness()
    h.update({
      parentEnded: true,
      outcome: 'success',
      children: [
        { ...child('done', 'settled'), id: 'agent', kind: 'agent' },
        { ...child('monitoring'), parentChildWorkId: 'agent' }
      ]
    })
    h.tick()
    expect(h.alerts).toEqual([])
  })
})
