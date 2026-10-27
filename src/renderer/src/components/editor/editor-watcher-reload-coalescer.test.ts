import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorWatcherReloadCoalescer } from './editor-watcher-reload-coalescer'

describe('createEditorWatcherReloadCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets a read slower than the stale limit finish under sustained changes', async () => {
    const coalescer = createEditorWatcherReloadCoalescer()
    let applied = 0
    let started = 0
    let latest = 0
    const load = (): Promise<void> => {
      const generation = ++started
      latest = generation
      return new Promise((resolve) =>
        setTimeout(() => {
          // Mirrors the loader: a superseded generation never applies.
          if (generation === latest) {
            applied++
          }
          resolve()
        }, 25_000)
      )
    }
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      coalescer.run('content:a', load)
      await vi.advanceTimersByTimeAsync(100)
    }
    // Changes never paused, yet the slow read must still land at least once.
    expect(applied).toBeGreaterThan(0)
  })

  it('replaces a hung read with the queued reload even after changes stop', async () => {
    const coalescer = createEditorWatcherReloadCoalescer()
    const load = vi.fn(() => new Promise<void>(() => {}))
    coalescer.run('content:a', load)
    await vi.advanceTimersByTimeAsync(1_000)
    coalescer.run('content:a', load)
    // No further watcher events arrive; the queued reload must still start.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('stops the watchdog when the coalescer is disposed', async () => {
    const coalescer = createEditorWatcherReloadCoalescer()
    const load = vi.fn(() => new Promise<void>(() => {}))
    coalescer.run('content:a', load)
    coalescer.run('content:a', load)
    coalescer.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
