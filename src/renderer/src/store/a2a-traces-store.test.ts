import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useA2AStore } from './a2a-traces-store'

describe('a2a-traces-store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useA2AStore.getState().clearTraces()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('adds trace with auto parsed indexes and adds to active and recent lists', () => {
    const trace = useA2AStore.getState().addTrace({
      from: '@2',
      to: '@5',
      type: 'send',
      text: 'npm test'
    })

    expect(trace.fromIndex).toBe(2)
    expect(trace.toIndex).toBe(5)
    expect(trace.type).toBe('send')
    expect(trace.text).toBe('npm test')

    const state = useA2AStore.getState()
    expect(state.activeLinks).toHaveLength(1)
    expect(state.recentTraces).toHaveLength(1)
    expect(state.activeLinks[0].id).toBe(trace.id)
  })

  it('automatically expires active link after duration', () => {
    const trace = useA2AStore.getState().addTrace({
      from: '@2',
      to: '@8',
      durationMs: 3000
    })

    expect(useA2AStore.getState().activeLinks).toHaveLength(1)

    vi.advanceTimersByTime(2999)
    expect(useA2AStore.getState().activeLinks).toHaveLength(1)

    vi.advanceTimersByTime(2)
    expect(useA2AStore.getState().activeLinks).toHaveLength(0)
    // Recent traces are still retained
    expect(useA2AStore.getState().recentTraces).toHaveLength(1)
    expect(useA2AStore.getState().recentTraces[0].id).toBe(trace.id)
  })

  it('supports replaying a trace from history', () => {
    const initial = useA2AStore.getState().addTrace({
      from: '@2',
      to: '@5',
      text: 'build',
      durationMs: 1000
    })

    vi.advanceTimersByTime(1100)
    expect(useA2AStore.getState().activeLinks).toHaveLength(0)

    useA2AStore.getState().replayTrace(initial.id)
    expect(useA2AStore.getState().activeLinks).toHaveLength(1)
    expect(useA2AStore.getState().activeLinks[0].fromIndex).toBe(2)
    expect(useA2AStore.getState().activeLinks[0].toIndex).toBe(5)
  })

  it('manually removes active link and clears traces', () => {
    const trace = useA2AStore.getState().addTrace({
      from: '@1',
      to: '@2'
    })

    expect(useA2AStore.getState().activeLinks).toHaveLength(1)
    useA2AStore.getState().removeActiveLink(trace.id)
    expect(useA2AStore.getState().activeLinks).toHaveLength(0)

    useA2AStore.getState().clearTraces()
    expect(useA2AStore.getState().recentTraces).toHaveLength(0)
  })
})
