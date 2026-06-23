import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __clearSelfWriteRegistryForTests,
  __getSelfWriteRegistrySizeForTests,
  clearSelfWrite,
  hasRecentSelfWrite,
  recordSelfWrite
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
})
