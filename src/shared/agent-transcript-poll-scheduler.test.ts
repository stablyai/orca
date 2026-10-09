import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watchers = vi.hoisted(() => ({
  bound: true,
  entries: Array<{
    wake: () => void
    error: () => void
    bind: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    rebind: boolean
  }>()
}))
vi.mock('./transcript-native-watcher', () => ({
  createTranscriptNativeWatcher: (_path: string, wake: () => void, error: () => void) => {
    const entry = {
      wake,
      error,
      rebind: true,
      bind: vi.fn(() => {
        entry.rebind = !watchers.bound
        return watchers.bound
      }),
      dispose: vi.fn()
    }
    watchers.entries.push(entry)
    return { bind: entry.bind, dispose: entry.dispose, needsRebind: () => entry.rebind }
  }
}))
import { AgentTranscriptPollScheduler } from './agent-transcript-poll-scheduler'
import { CodexSubagentPollScheduler } from './codex-subagent-poll-scheduler'

describe('host transcript wakeup budget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    watchers.bound = true
    watchers.entries.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it.each([500, 1_000])(
    'bounds quiet root probes across 100 panes with one timer (cadence %i ms)',
    (cadence) => {
      let before = 0
      let after = 0
      const baseline = new CodexSubagentPollScheduler<number>(cadence, (key, value) => {
        before++
        baseline.schedule(key, value)
      })
      const optimized = new AgentTranscriptPollScheduler<number>(cadence, (key, value) => {
        after++
        optimized.schedule(key, value, `/rollout-${key}.jsonl`)
      })
      for (let i = 0; i < 100; i++) {
        baseline.schedule(String(i), i)
        optimized.schedule(String(i), i, `/rollout-${i}.jsonl`)
      }
      expect(vi.getTimerCount()).toBe(2)
      vi.advanceTimersByTime(60_000)
      expect(before).toBe(100 * (60_000 / cadence))
      expect(after).toBe(1_200)
      optimized.clearAll()
      baseline.clearAll()
      expect(vi.getTimerCount()).toBe(0)
      expect(watchers.entries.every((entry) => entry.dispose.mock.calls.length === 1)).toBe(true)
    }
  )

  it('coalesces a stream without postponing reads and reuses the latest hook', () => {
    const seen: string[] = []
    const scheduler = new AgentTranscriptPollScheduler<string>(500, (key, value) => {
      seen.push(value)
      scheduler.schedule(key, value, '/rollout.jsonl')
    })
    scheduler.schedule('pane', 'first', '/rollout.jsonl')
    vi.advanceTimersByTime(500)
    const watch = watchers.entries[0]!
    for (let i = 0; i < 1_000; i++) {
      watch.wake()
      scheduler.schedule('pane', `hook-${i}`, '/rollout.jsonl')
    }
    expect(watchers.entries).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['first', 'hook-999'])
    scheduler.clear('pane')
    watch.wake()
    expect(vi.getTimerCount()).toBe(0)
    expect(watch.dispose).toHaveBeenCalledOnce()
  })

  it('keeps unreadable watches on the old cadence but bounds bind retries', () => {
    watchers.bound = false
    let reads = 0
    const scheduler = new AgentTranscriptPollScheduler<number>(500, (key, value) => {
      reads++
      scheduler.schedule(key, value, '/missing.jsonl')
    })
    scheduler.schedule('pane', 1, '/missing.jsonl')
    vi.advanceTimersByTime(10_000)
    expect(reads).toBe(20)
    expect(watchers.entries[0]!.bind).toHaveBeenCalledTimes(3)
    scheduler.clearAll()
  })

  it('rebinds after rename or error and drops replaced watches and stale callbacks', () => {
    const seen: number[] = []
    const scheduler = new AgentTranscriptPollScheduler<number>(500, (key, value) => {
      seen.push(value)
      scheduler.schedule(key, value, '/new.jsonl')
    })
    scheduler.schedule('pane', 1, '/old.jsonl')
    const old = watchers.entries[0]!
    scheduler.schedule('pane', 2, '/new.jsonl')
    old.wake()
    expect(old.dispose).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(500)
    const current = watchers.entries[1]!
    current.rebind = true
    current.wake()
    vi.advanceTimersByTime(500)
    expect(current.bind).toHaveBeenCalledTimes(2)
    current.rebind = true
    current.error()
    vi.advanceTimersByTime(500)
    expect(current.bind).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([2, 2, 2])
    scheduler.clearAll()
  })

  it('retains polling for children and WSL UNC and releases abandoned callbacks', () => {
    const seen = vi.fn()
    const scheduler = new AgentTranscriptPollScheduler<number>(500, seen)
    scheduler.schedule('child', 1)
    scheduler.schedule('wsl', 2, '\\\\wsl.localhost\\Ubuntu\\rollout.jsonl')
    scheduler.schedule('root', 3, '/rollout.jsonl')
    vi.advanceTimersByTime(500)
    expect(seen).toHaveBeenCalledTimes(3)
    expect(watchers.entries).toHaveLength(1)
    expect(watchers.entries[0]!.dispose).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
