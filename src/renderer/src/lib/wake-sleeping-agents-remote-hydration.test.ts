// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundSleepingAgentWakeDispatcher } from './wake-sleeping-agents-in-background'

const dispatchers: { dispose: () => void }[] = []

afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) {
    dispatcher.dispose()
  }
})

function createHarness(targets: Record<string, string | null>) {
  let listener: (() => void) | null = null
  const unsubscribe = vi.fn()
  const wake = vi.fn()
  const resume = vi.fn()
  const dispatcher = createBackgroundSleepingAgentWakeDispatcher({
    isWorkspaceSessionReady: () => true,
    subscribeToStore: (nextListener) => {
      listener = nextListener
      return unsubscribe
    },
    wake,
    resume,
    getRemoteHydrationTargetId: (worktreeId) => targets[worktreeId] ?? null
  })
  dispatchers.push(dispatcher)
  return {
    dispatcher,
    wake,
    resume,
    unsubscribe,
    notifyStore: () => listener?.()
  }
}

describe('background sleeping-agent wake dispatcher — remote hydration', () => {
  it('runs immediately when the remote snapshot API is unavailable', () => {
    const wake = vi.fn()
    const getRemoteHydrationTargetId = vi.fn(() => 'target-a')
    const dispatcher = createBackgroundSleepingAgentWakeDispatcher({
      isWorkspaceSessionReady: () => true,
      wake,
      getRemoteHydrationTargetId,
      remoteHydrationEnabled: false
    })
    dispatchers.push(dispatcher)

    expect(dispatcher.requestActivation('wt-a')).toBe(false)
    dispatcher.request('wt-a')

    expect(wake).toHaveBeenCalledWith('wt-a')
    expect(getRemoteHydrationTargetId).not.toHaveBeenCalled()
  })

  it('coalesces duplicate activation and background intent into one background wake', () => {
    const harness = createHarness({ 'wt-a': 'target-a' })
    harness.dispatcher.remotePullStarted('target-a')

    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)
    harness.dispatcher.request('wt-a')
    harness.dispatcher.request('wt-a')
    harness.dispatcher.remotePullSettled('target-a')

    expect(harness.wake).toHaveBeenCalledOnce()
    expect(harness.wake).toHaveBeenCalledWith('wt-a')
    expect(harness.resume).not.toHaveBeenCalled()
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('waits for the last overlapping pull before replaying a stale arrival', () => {
    const harness = createHarness({ 'wt-a': 'target-a' })
    harness.dispatcher.remotePullStarted('target-a')
    harness.dispatcher.remotePullStarted('target-a')
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)

    harness.dispatcher.remotePullSettled('target-a')
    expect(harness.resume).not.toHaveBeenCalled()

    harness.dispatcher.remotePullSettled('target-a')
    expect(harness.resume).toHaveBeenCalledOnce()

    expect(harness.dispatcher.requestActivation('wt-a')).toBe(false)
    harness.dispatcher.remotePullStarted('target-a')
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)
  })

  it('replays on successful hydration before pull finalization without duplicating', () => {
    const targets: Record<string, string | null> = { 'wt-a': 'target-a' }
    const harness = createHarness(targets)
    harness.dispatcher.remotePullStarted('target-a')
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)

    targets['wt-a'] = null
    harness.notifyStore()
    expect(harness.resume).toHaveBeenCalledOnce()

    harness.dispatcher.remotePullSettled('target-a')
    expect(harness.resume).toHaveBeenCalledOnce()
  })

  it('isolates target outcomes', () => {
    const harness = createHarness({ 'wt-a': 'target-a', 'wt-b': 'target-b' })
    harness.dispatcher.remotePullStarted('target-a')
    harness.dispatcher.remotePullStarted('target-b')
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)
    expect(harness.dispatcher.requestActivation('wt-b')).toBe(true)

    harness.dispatcher.remotePullSettled('target-a')
    expect(harness.resume).toHaveBeenCalledWith('wt-a')
    expect(harness.resume).not.toHaveBeenCalledWith('wt-b')

    harness.dispatcher.remotePullSettled('target-b')
    expect(harness.resume).toHaveBeenCalledWith('wt-b')
  })

  it('bounds remembered terminal targets', () => {
    const harness = createHarness({ 'wt-a': 'target-0' })
    for (let index = 0; index <= 256; index += 1) {
      const targetId = `target-${index}`
      harness.dispatcher.remotePullStarted(targetId)
      harness.dispatcher.remotePullSettled(targetId)
    }

    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)
  })

  it('reclassifies intent when topology moves to another target', () => {
    const targets: Record<string, string | null> = { 'wt-a': 'target-a' }
    const harness = createHarness(targets)
    harness.dispatcher.remotePullStarted('target-a')
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)

    targets['wt-a'] = 'target-b'
    harness.notifyStore()
    harness.dispatcher.remotePullSettled('target-a')
    expect(harness.resume).not.toHaveBeenCalled()

    harness.dispatcher.remotePullStarted('target-b')
    harness.dispatcher.remotePullSettled('target-b')
    expect(harness.resume).toHaveBeenCalledOnce()
  })

  it('replays and clears an intent when its worktree leaves snapshot topology', () => {
    const targets: Record<string, string | null> = { 'wt-a': 'target-a' }
    const harness = createHarness(targets)
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)

    targets['wt-a'] = null
    harness.notifyStore()
    harness.notifyStore()

    expect(harness.resume).toHaveBeenCalledOnce()
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('disposes queued intent, pull state, and subscription', () => {
    const harness = createHarness({ 'wt-a': 'target-a' })
    harness.dispatcher.remotePullStarted('target-a')
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(true)

    harness.dispatcher.dispose()
    harness.dispatcher.remotePullSettled('target-a')

    expect(harness.resume).not.toHaveBeenCalled()
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.dispatcher.requestActivation('wt-a')).toBe(false)
  })
})
