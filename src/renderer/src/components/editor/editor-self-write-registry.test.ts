import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '../../../../shared/timer-delay'
import {
  __clearSelfWriteRegistryForTests,
  __getSelfWriteRegistrySizeForTests,
  clearSelfWrite,
  getRecentSelfWrite,
  hasRecentSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'

describe('editor self-write registry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    __clearSelfWriteRegistryForTests()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('matches Windows drive paths case-insensitively', () => {
    recordSelfWrite('C:\\Repo\\a.md')

    expect(hasRecentSelfWrite('c:\\repo\\a.md')).toBe(true)

    clearSelfWrite('c:\\repo\\a.md')
    expect(hasRecentSelfWrite('C:\\Repo\\a.md')).toBe(false)
  })

  it('matches Windows UNC paths case-insensitively', () => {
    recordSelfWrite('\\\\Server\\Share\\Repo\\a.md')

    expect(hasRecentSelfWrite('\\\\server\\share\\repo\\a.md')).toBe(true)
  })

  it('keeps POSIX path casing distinct', () => {
    recordSelfWrite('/Repo/a.md')

    expect(hasRecentSelfWrite('/repo/a.md')).toBe(false)
  })

  it('keeps same-path stamps isolated by runtime owner', () => {
    recordSelfWrite('/repo/a.md', 'runtime save', 'env-1')

    expect(hasRecentSelfWrite('/repo/a.md', 'env-1')).toBe(true)
    expect(hasRecentSelfWrite('/repo/a.md', null)).toBe(false)

    clearSelfWrite('/repo/a.md', null)
    expect(hasRecentSelfWrite('/repo/a.md', 'env-1')).toBe(true)

    clearSelfWrite('/repo/a.md', 'env-1')
    expect(hasRecentSelfWrite('/repo/a.md', 'env-1')).toBe(false)
  })

  it('trims runtime owner ids when matching stamps', () => {
    recordSelfWrite('/repo/a.md', 'runtime save', ' env-1 ')

    expect(hasRecentSelfWrite('/repo/a.md', 'env-1')).toBe(true)
  })

  it('prunes expired stamps when recording later writes', () => {
    recordSelfWrite('/repo/old.md')

    vi.advanceTimersByTime(751)
    recordSelfWrite('/repo/new.md')

    expect(__getSelfWriteRegistrySizeForTests()).toBe(1)
    expect(hasRecentSelfWrite('/repo/old.md')).toBe(false)
    expect(hasRecentSelfWrite('/repo/new.md')).toBe(true)
  })

  it('caps retained stamps', () => {
    for (let i = 0; i < 260; i++) {
      recordSelfWrite(`/repo/${i}.md`)
    }

    expect(__getSelfWriteRegistrySizeForTests()).toBe(256)
    expect(hasRecentSelfWrite('/repo/0.md')).toBe(false)
    expect(hasRecentSelfWrite('/repo/259.md')).toBe(true)
  })

  it('keeps remote-TTL stamps alive past the local window', () => {
    // Why: SSH/runtime watcher echoes can land seconds after the write; the
    // longer TTL keeps them recognized as Orca's own save.
    recordSelfWrite('/repo/remote.md', 'content', 'env-1', SELF_WRITE_REMOTE_TTL_MS)

    vi.advanceTimersByTime(751)
    expect(hasRecentSelfWrite('/repo/remote.md', 'env-1')).toBe(true)
    vi.advanceTimersByTime(SELF_WRITE_REMOTE_TTL_MS)
    expect(hasRecentSelfWrite('/repo/remote.md', 'env-1')).toBe(false)
  })

  it('releases expired saved content while idle without another registry read or write', () => {
    recordSelfWrite('/repo/closed.json', 'saved file content')
    vi.advanceTimersByTime(750)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(1)
    expect(getRecentSelfWrite('/repo/closed.json')?.content).toBe('saved file content')

    vi.advanceTimersByTime(1)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a refreshed stamp through the previous deadline', () => {
    recordSelfWrite('/repo/refresh.json', 'first save')
    vi.advanceTimersByTime(500)
    recordSelfWrite('/repo/refresh.json', 'second save')
    vi.advanceTimersByTime(251)
    expect(getRecentSelfWrite('/repo/refresh.json')?.content).toBe('second save')
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(500)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('schedules an earlier local expiry without shortening a remote stamp', () => {
    recordSelfWrite('/repo/same.json', 'remote save', 'env-1', SELF_WRITE_REMOTE_TTL_MS)
    vi.advanceTimersByTime(100)
    recordSelfWrite('/repo/same.json', 'local save')
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(751)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(1)
    expect(getRecentSelfWrite('/repo/same.json', 'env-1')?.content).toBe('remote save')
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(2150)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels expiry work when a failed write clears the last stamp', () => {
    recordSelfWrite('/repo/failed.json', 'failed save')
    expect(vi.getTimerCount()).toBe(1)
    clearSelfWrite('/repo/failed.json')
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks the existing wall-clock deadline after the clock moves backward', () => {
    recordSelfWrite('/repo/clock.json', 'saved content')
    vi.setSystemTime(-1000)
    vi.advanceTimersByTime(751)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the shared timer when the registry is reset', () => {
    recordSelfWrite('/repo/reset.json', 'saved content')
    __clearSelfWriteRegistryForTests()
    expect(__getSelfWriteRegistrySizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds the timer delay after a large backward clock change', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    recordSelfWrite('/repo/clock.json', 'saved content')
    vi.setSystemTime(-MAX_TIMER_DELAY_MS)
    vi.advanceTimersByTime(751)

    expect(__getSelfWriteRegistrySizeForTests()).toBe(1)
    expect(timeout.mock.calls.at(-1)?.[1]).toBe(MAX_TIMER_DELAY_MS)
    expect(vi.getTimerCount()).toBe(1)
  })
})
