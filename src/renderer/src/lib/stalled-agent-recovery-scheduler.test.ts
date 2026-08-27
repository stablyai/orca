import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStallObservation } from '../../../shared/agent-stall-recovery-policy'

type SchedulerTestState = {
  agentStallByPaneKey: Record<string, AgentStallObservation>
  settings: { autoRecoverStalledAgents?: boolean } | null
}

const testState = vi.hoisted(() => ({
  appState: null as unknown as SchedulerTestState,
  listeners: [] as ((state: unknown, previous: unknown) => void)[]
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: SchedulerTestState) => unknown) => selector(testState.appState),
    {
      getState: () => testState.appState,
      subscribe: (listener: (state: unknown, previous: unknown) => void) => {
        testState.listeners.push(listener)
        return () => {
          testState.listeners = testState.listeners.filter((entry) => entry !== listener)
        }
      }
    }
  )
}))

const { installAutomaticAgentStallRecovery, isAutomaticAgentStallRecoveryEnabled } =
  await import('./stalled-agent-recovery-scheduler')

function observation(paneKey: string): AgentStallObservation {
  return { paneKey, cause: 'network', signature: 'Connection error', observedAt: 0 }
}

function createTimerHarness(): {
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  tick: () => void
  active: () => number
} {
  const callbacks = new Map<number, () => void>()
  let nextId = 1
  return {
    setInterval: ((callback: () => void) => {
      const id = nextId++
      callbacks.set(id, callback)
      return id as unknown as ReturnType<typeof globalThis.setInterval>
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((id: number) => {
      callbacks.delete(id)
    }) as unknown as typeof globalThis.clearInterval,
    tick: () => {
      for (const callback of callbacks.values()) {
        callback()
      }
    },
    active: () => callbacks.size
  }
}

/** Fires the store subscription the same way zustand does after a write. */
function notifyStoreWrite(previous: Partial<SchedulerTestState>): void {
  for (const listener of testState.listeners) {
    listener(testState.appState, { ...testState.appState, ...previous })
  }
}

describe('automatic agent stall recovery scheduler', () => {
  beforeEach(() => {
    testState.appState = { agentStallByPaneKey: {}, settings: {} }
    testState.listeners = []
  })

  it('is on unless the setting is explicitly off', () => {
    expect(isAutomaticAgentStallRecoveryEnabled(undefined)).toBe(true)
    expect(isAutomaticAgentStallRecoveryEnabled({})).toBe(true)
    expect(isAutomaticAgentStallRecoveryEnabled({ autoRecoverStalledAgents: false })).toBe(false)
  })

  it('polls only while a stall is outstanding', () => {
    const timers = createTimerHarness()
    const recover = vi.fn().mockResolvedValue([])

    const uninstall = installAutomaticAgentStallRecovery({ ...timers, recover })
    expect(timers.active()).toBe(0)

    const empty = testState.appState.agentStallByPaneKey
    testState.appState.agentStallByPaneKey = { 'tab-a:leaf': observation('tab-a:leaf') }
    notifyStoreWrite({ agentStallByPaneKey: empty })
    expect(timers.active()).toBe(1)

    timers.tick()
    expect(recover).toHaveBeenCalledTimes(1)

    const outstanding = testState.appState.agentStallByPaneKey
    testState.appState.agentStallByPaneKey = {}
    notifyStoreWrite({ agentStallByPaneKey: outstanding })
    expect(timers.active()).toBe(0)

    uninstall()
  })

  it('never runs two fleet walks at once', async () => {
    const timers = createTimerHarness()
    // Holder, not a bare `let`: TS narrows a closure-assigned local to `null`.
    const pending: { release: (() => void) | null } = { release: null }
    const recover = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          pending.release = () => resolve([])
        })
    )
    testState.appState.agentStallByPaneKey = { 'tab-a:leaf': observation('tab-a:leaf') }

    const uninstall = installAutomaticAgentStallRecovery({ ...timers, recover })
    timers.tick()
    timers.tick()

    expect(recover).toHaveBeenCalledTimes(1)

    pending.release?.()
    await Promise.resolve()
    await Promise.resolve()
    timers.tick()

    expect(recover).toHaveBeenCalledTimes(2)

    uninstall()
  })

  it('stops polling when the user turns the setting off, and resumes when back on', () => {
    const timers = createTimerHarness()
    const recover = vi.fn().mockResolvedValue([])
    testState.appState.agentStallByPaneKey = { 'tab-a:leaf': observation('tab-a:leaf') }

    const uninstall = installAutomaticAgentStallRecovery({ ...timers, recover })
    expect(timers.active()).toBe(1)

    testState.appState.settings = { autoRecoverStalledAgents: false }
    notifyStoreWrite({ settings: { autoRecoverStalledAgents: true } })
    expect(timers.active()).toBe(0)

    testState.appState.settings = { autoRecoverStalledAgents: true }
    notifyStoreWrite({ settings: { autoRecoverStalledAgents: false } })
    expect(timers.active()).toBe(1)

    uninstall()
    expect(timers.active()).toBe(0)
  })

  it('drops its subscription and timer on uninstall', () => {
    const timers = createTimerHarness()
    const recover = vi.fn().mockResolvedValue([])
    testState.appState.agentStallByPaneKey = { 'tab-a:leaf': observation('tab-a:leaf') }

    installAutomaticAgentStallRecovery({ ...timers, recover })()

    expect(testState.listeners).toHaveLength(0)
    expect(timers.active()).toBe(0)
  })
})
