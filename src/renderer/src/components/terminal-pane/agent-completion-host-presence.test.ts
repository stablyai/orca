import { describe, expect, it, vi } from 'vitest'
import type {
  AgentProcessPresence,
  AgentProcessVerdict
} from '../../../../shared/agent-process-presence'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  createDeferred,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

const owner = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'birth' }
} as const

function presenceFeed(initial: AgentProcessPresence) {
  let current: AgentProcessPresence | undefined = initial
  const listeners = new Set<(presence: AgentProcessPresence | undefined) => void>()
  return {
    get: () => current,
    set: (next: AgentProcessPresence | undefined) => {
      current = next
      for (const listener of listeners) {
        listener(next)
      }
    },
    subscribe: (listener: (presence: AgentProcessPresence | undefined) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

describe('completion from the recorded process owner', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('never polls a live owner and completes once from the host exit', async () => {
    const feed = presenceFeed(owner)
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const dispatchCompletion = vi.fn()
    const checkAgentPresence = vi.fn(async (): Promise<AgentProcessVerdict> => 'live')
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: feed.get,
      subscribeAgentPresence: feed.subscribe,
      checkAgentPresence,
      inspectProcess,
      dispatchCompletion
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('⠋ Claude working')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(checkAgentPresence).not.toHaveBeenCalled()
    expect(inspectProcess).not.toHaveBeenCalled()
    expect(dispatchCompletion).not.toHaveBeenCalled()

    feed.set({ ...owner, ended: true })
    feed.set({ ...owner, ended: true })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ source: 'process-exit' })
    )
    coordinator.dispose()
  })

  it('asks the host about the exact owner only when a title needs validating', async () => {
    const feed = presenceFeed(owner)
    const checkAgentPresence = vi.fn(async (): Promise<AgentProcessVerdict> => 'live')
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: feed.get,
      subscribeAgentPresence: feed.subscribe,
      checkAgentPresence,
      inspectProcess: vi.fn(async () => processResult(null, false)),
      dispatchCompletion: vi.fn()
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('⠋ Claude working')
    coordinator.observeTitle('orca')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(checkAgentPresence).toHaveBeenCalledTimes(1)
    expect(checkAgentPresence).toHaveBeenCalledWith(owner.process)
    coordinator.dispose()
  })

  it('does not credit a replacement owner with a delayed verdict', async () => {
    const feed = presenceFeed(owner)
    const deferred = createDeferred<AgentProcessVerdict>()
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: feed.get,
      subscribeAgentPresence: feed.subscribe,
      checkAgentPresence: () => deferred.promise,
      inspectProcess,
      dispatchCompletion
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('⠋ Claude working')
    coordinator.observeTitle('orca')
    await vi.advanceTimersByTimeAsync(1_000)
    feed.set({ ...owner, process: { ...owner.process, startTime: 'replacement' } })
    deferred.resolve('exited')
    await vi.advanceTimersByTimeAsync(1)
    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(inspectProcess).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('hands a pane whose owner exited back to the legacy reads for the next agent', async () => {
    const feed = presenceFeed({ ...owner, ended: true })
    const inspectProcess = vi.fn(async () => processResult('codex', true))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: feed.get,
      subscribeAgentPresence: feed.subscribe,
      checkAgentPresence: vi.fn(async (): Promise<AgentProcessVerdict> => 'exited'),
      inspectProcess,
      dispatchCompletion: vi.fn()
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('⠋ codex working')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(inspectProcess).toHaveBeenCalled()
    coordinator.dispose()
  })

  it('reports no finished task when the host releases the owner with its terminal', async () => {
    const feed = presenceFeed(owner)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: feed.get,
      subscribeAgentPresence: feed.subscribe,
      inspectProcess: vi.fn(async () => processResult(null, false)),
      dispatchCompletion
    })
    coordinator.startProcessTracking()
    coordinator.observeTitle('⠋ Claude working')
    feed.set(undefined)
    await vi.advanceTimersByTimeAsync(10)
    expect(dispatchCompletion).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it.each([
    ['a resumed owner that never ran a turn', [], 0],
    ['a turn cut short by the exit', ['⠋ Claude working'], 1]
  ])('announces the exit of %s only for a turn not yet notified', (_case, titles, expected) => {
    const feed = presenceFeed(owner)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: feed.get,
      subscribeAgentPresence: feed.subscribe,
      checkAgentPresence: vi.fn(async (): Promise<AgentProcessVerdict> => 'live'),
      inspectProcess: vi.fn(async () => processResult(null, false)),
      dispatchCompletion
    })
    coordinator.startProcessTracking()
    // Claude's idle frame is run evidence without a turn.
    coordinator.observeTitle('✳ Claude Code')
    for (const title of titles) {
      coordinator.observeTitle(title)
    }
    feed.set({ ...owner, ended: true })
    expect(dispatchCompletion).toHaveBeenCalledTimes(expected)
    coordinator.dispose()
  })

  it('does not announce the exit again once its turn was notified', async () => {
    const feed = presenceFeed(owner)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab:leaf',
      getPtyId: () => 'pty',
      getSettings: () => null,
      isLive: () => true,
      getAgentPresence: feed.get,
      subscribeAgentPresence: feed.subscribe,
      checkAgentPresence: vi.fn(async (): Promise<AgentProcessVerdict> => 'live'),
      inspectProcess: vi.fn(async () => processResult(null, false)),
      dispatchCompletion
    })
    coordinator.startProcessTracking()
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      stateStartedAt: 1
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'p',
      agentType: 'claude',
      stateStartedAt: 2
    })
    await vi.advanceTimersByTimeAsync(HOOK_DONE_QUIET_MS)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    feed.set({ ...owner, ended: true })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    coordinator.dispose()
  })
})
