import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __clearSelfWriteRegistryForTests,
  __getSelfWriteRegistrySizeForTests,
  clearSelfWrite,
  deferUntilFormatterSettles,
  getRecentSelfWrite,
  hasRecentSelfWrite,
  recordFormatterPendingSelfWrite,
  recordSelfWrite,
  SELF_WRITE_FORMATTER_PENDING_TTL_MS,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'

describe('editor self-write registry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    __clearSelfWriteRegistryForTests()
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

  describe('deferred watcher work', () => {
    it('refuses to hold work unless a formatter is pending', () => {
      const replay = vi.fn()
      expect(deferUntilFormatterSettles('/repo/a.ts', undefined, 'k', replay)).toBe(false)

      recordSelfWrite('/repo/a.ts', 'saved')
      expect(deferUntilFormatterSettles('/repo/a.ts', undefined, 'k', replay)).toBe(false)
    })

    it('replays held work once, keeping only the latest per key, when the real stamp lands', async () => {
      const first = vi.fn()
      const latest = vi.fn()
      const other = vi.fn()
      recordFormatterPendingSelfWrite('/repo/a.ts')
      expect(deferUntilFormatterSettles('/repo/a.ts', undefined, 'k', first)).toBe(true)
      deferUntilFormatterSettles('/repo/a.ts', undefined, 'k', latest)
      deferUntilFormatterSettles('/repo/a.ts', undefined, 'other', other)
      await Promise.resolve()
      expect(latest).not.toHaveBeenCalled()

      recordSelfWrite('/repo/a.ts', 'formatted')
      await Promise.resolve()

      expect(first).not.toHaveBeenCalled()
      expect(latest).toHaveBeenCalledTimes(1)
      expect(other).toHaveBeenCalledTimes(1)
    })

    it('replays held work when the pending stamp is cleared or expires', async () => {
      const cleared = vi.fn()
      recordFormatterPendingSelfWrite('/repo/a.ts')
      deferUntilFormatterSettles('/repo/a.ts', undefined, 'k', cleared)
      clearSelfWrite('/repo/a.ts')
      await Promise.resolve()
      expect(cleared).toHaveBeenCalledTimes(1)

      const expired = vi.fn()
      recordFormatterPendingSelfWrite('/repo/b.ts')
      deferUntilFormatterSettles('/repo/b.ts', undefined, 'k', expired)
      vi.advanceTimersByTime(SELF_WRITE_FORMATTER_PENDING_TTL_MS + 1)
      expect(hasRecentSelfWrite('/repo/b.ts')).toBe(false)
      await Promise.resolve()
      expect(expired).toHaveBeenCalledTimes(1)
    })

    it('keeps a pending stamp and its held work when capacity eviction runs', async () => {
      const held = vi.fn()
      recordFormatterPendingSelfWrite('/repo/pending.ts')
      deferUntilFormatterSettles('/repo/pending.ts', undefined, 'k', held)

      // Why: the pending stamp is the oldest entry, so a plain oldest-first eviction would drop it first.
      for (let index = 0; index < 300; index++) {
        recordSelfWrite(`/repo/filler-${index}.ts`, 'x')
      }
      expect(__getSelfWriteRegistrySizeForTests()).toBeLessThanOrEqual(256)
      expect(getRecentSelfWrite('/repo/pending.ts')).toEqual({
        content: null,
        formatterPending: true
      })

      recordSelfWrite('/repo/pending.ts', 'formatted')
      await Promise.resolve()
      expect(held).toHaveBeenCalledTimes(1)
    })
  })
})
