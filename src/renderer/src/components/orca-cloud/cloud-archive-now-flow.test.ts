import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/orca-cloud/orca-cloud-workspace-store', () => ({
  refreshCloudWorkspaceStatus: vi.fn(async () => undefined)
}))

import { runArchiveNow, type ArchiveNowDeps } from './cloud-archive-now-flow'
import {
  getCloudArchiveFailure as failureFor,
  getOptimisticArchive,
  resetOptimisticCloudArchivesForTests
} from '@/lib/orca-cloud/optimistic-cloud-archive'
import { noteCloudWorkspaceDeleting } from '@/lib/orca-cloud/pending-cloud-archive'

const failure = {
  state: 'failed' as const,
  runs: [{ path: '/w/a', exitCode: 3, timedOut: false, output: 'neon: 401' }]
}

function deps(over: Partial<ArchiveNowDeps> = {}): ArchiveNowDeps {
  return {
    undoMs: 5_000,
    hookNeedsWake: false,
    runHook: vi.fn(async () => null),
    commit: vi.fn(async (beforeSleep) =>
      (await beforeSleep())
        ? { ok: true as const, value: null }
        : { ok: false as const, code: 'failed' as const, message: 'kept', userMessage: 'kept' }
    ),
    reportFailure: () => true,
    describeFailure: (result) => result.userMessage ?? result.message,
    inFront: () => true,
    toastFailure: vi.fn(),
    ...over
  }
}

describe('ARCHIVE-NOW: Archive shows the archived page at once', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetOptimisticCloudArchivesForTests()
  })
  afterEach(() => vi.useRealTimers())

  it('shows archived with Undo before anything runs; Undo puts it back and runs nothing', async () => {
    const d = deps()
    const done = runArchiveNow('a', d)
    const shown = getOptimisticArchive('a')
    expect(shown?.phase).toBe('undo')
    if (shown?.phase === 'undo') {
      shown.undo()
    }
    expect(await done).toBe(false)
    expect(getOptimisticArchive('a')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(d.commit).not.toHaveBeenCalled()
  })

  it('after the window it archives and keeps the page until it is real', async () => {
    const d = deps()
    const done = runArchiveNow('a', d)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await done).toBe(true)
    expect(d.runHook).toHaveBeenCalledWith(false)
    expect(getOptimisticArchive('a')).toBeUndefined()
  })

  it('a failed hook asks on the page; Keep it reverts and says why inline', async () => {
    const d = deps({ runHook: vi.fn(async () => failure) })
    const done = runArchiveNow('a', d)
    await vi.advanceTimersByTimeAsync(5_000)
    const asked = getOptimisticArchive('a')
    expect(asked).toMatchObject({ phase: 'hook-failed', failure })
    if (asked?.phase === 'hook-failed') {
      asked.decide(false)
    }
    expect(await done).toBe(false)
    expect(getOptimisticArchive('a')).toBeUndefined()
    expect(failureFor('a')).toBe('kept')
  })

  it('Archive anyway after a failed hook archives', async () => {
    const d = deps({ runHook: vi.fn(async () => failure) })
    const done = runArchiveNow('a', d)
    await vi.advanceTimersByTimeAsync(5_000)
    const asked = getOptimisticArchive('a')
    if (asked?.phase === 'hook-failed') {
      asked.decide(true)
    }
    expect(await done).toBe(true)
    expect(failureFor('a')).toBeUndefined()
  })

  it('Skip script, offered when it would wake for the hook, archives without running it', async () => {
    const d = deps({ hookNeedsWake: true })
    const done = runArchiveNow('a', d)
    const shown = getOptimisticArchive('a')
    if (shown?.phase === 'undo') {
      shown.skipHook?.()
    }
    expect(getOptimisticArchive('a')).not.toHaveProperty('skipHook')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await done).toBe(true)
    expect(d.runHook).not.toHaveBeenCalled()
  })

  it('a Delete during the window cancels it', async () => {
    const d = deps()
    const done = runArchiveNow('a', d)
    noteCloudWorkspaceDeleting('a')
    expect(await done).toBe(false)
    expect(getOptimisticArchive('a')).toBeUndefined()
  })
})
