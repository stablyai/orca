import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __clearSelfWriteRegistryForTests,
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
})
