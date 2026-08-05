import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  lookupWorktreeListedPathExists,
  normalizeWorktreeRelativePathKey,
  primeTerminalWorktreePathIndex,
  releaseTerminalWorktreePathIndexLease,
  resetTerminalWorktreePathIndexForTests,
  seedTerminalWorktreePathIndexForTests,
  terminalWorktreePathIndexOwnerKey
} from './terminal-worktree-path-index'

afterEach(() => {
  resetTerminalWorktreePathIndexForTests()
  vi.useRealTimers()
})

describe('normalizeWorktreeRelativePathKey', () => {
  it('normalizes backslashes and leading slashes', () => {
    expect(normalizeWorktreeRelativePathKey('src\\foo.ts')).toBe('src/foo.ts')
    expect(normalizeWorktreeRelativePathKey('/src/foo.ts')).toBe('src/foo.ts')
  })
})

describe('terminalWorktreePathIndexOwnerKey', () => {
  it('prefers runtime over ssh over local', () => {
    expect(
      terminalWorktreePathIndexOwnerKey({
        runtimeEnvironmentId: 'env-1',
        connectionId: 'ssh-1'
      })
    ).toBe('runtime:env-1')
    expect(terminalWorktreePathIndexOwnerKey({ connectionId: 'ssh-1' })).toBe('ssh:ssh-1')
    expect(terminalWorktreePathIndexOwnerKey({})).toBe('local')
  })
})

describe('lookupWorktreeListedPathExists', () => {
  it('returns true only for positive index hits under the matching owner', () => {
    seedTerminalWorktreePathIndexForTests('wt-1', '/repo', ['src/foo.ts', 'README.md'], 'local')

    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/src/foo.ts', 'local')).toBe(true)
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/README.md', 'local')).toBe(true)
    expect(
      lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/missing.ts', 'local')
    ).toBeUndefined()
    expect(
      lookupWorktreeListedPathExists('wt-1', '/repo', '/outside/foo.ts', 'local')
    ).toBeUndefined()
    expect(
      lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/src/foo.ts', 'ssh:other')
    ).toBeUndefined()
  })

  it('ignores stale positive hits after STALE_MS', () => {
    vi.useFakeTimers()
    seedTerminalWorktreePathIndexForTests('wt-1', '/repo', ['a.ts'], 'local')
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/a.ts', 'local')).toBe(true)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/a.ts', 'local')).toBeUndefined()
  })

  it('reloads on lookup when a leased index is stale', async () => {
    vi.useFakeTimers()
    const listRelativePaths = vi
      .fn()
      .mockResolvedValueOnce(['a.ts'])
      .mockResolvedValueOnce(['a.ts', 'b.ts'])

    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/a.ts', 'local')).toBe(true)

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/a.ts', 'local')).toBeUndefined()
    expect(listRelativePaths).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(0)
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/b.ts', 'local')).toBe(true)
  })

  it('treats a successful empty listing as fresh positive-evidence set', async () => {
    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths: async () => []
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/a.ts', 'local')).toBeUndefined()
    const listRelativePaths = vi.fn(async () => ['a.ts'])
    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths
    })
    expect(listRelativePaths).not.toHaveBeenCalled()
  })
})

describe('primeTerminalWorktreePathIndex', () => {
  it('loads relative paths without blocking and serves later lookups', async () => {
    let resolveList!: (paths: string[]) => void
    const listPromise = new Promise<string[]>((resolve) => {
      resolveList = resolve
    })
    const listRelativePaths = vi.fn((_token: string) => listPromise)

    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths
    })
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/a.ts', 'local')).toBeUndefined()

    resolveList(['a.ts', 'nested\\b.ts'])
    await listPromise
    await Promise.resolve()

    expect(listRelativePaths).toHaveBeenCalledOnce()
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/a.ts', 'local')).toBe(true)
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/nested/b.ts', 'local')).toBe(true)
  })

  it('does not start a second load while one is in flight', () => {
    const listRelativePaths = vi.fn((_token: string) => new Promise<string[]>(() => {}))
    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths
    })
    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths
    })
    expect(listRelativePaths).toHaveBeenCalledOnce()
  })

  it('only cancels when the last lease is released', async () => {
    let resolveList!: (paths: string[]) => void
    const listPromise = new Promise<string[]>((resolve) => {
      resolveList = resolve
    })
    const cancelLoad = vi.fn()
    const listRelativePaths = vi.fn(() => listPromise)

    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths,
      cancelLoad
    })
    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths,
      cancelLoad
    })
    expect(listRelativePaths).toHaveBeenCalledOnce()

    releaseTerminalWorktreePathIndexLease('wt-1', '/repo', 'local')
    expect(cancelLoad).not.toHaveBeenCalled()

    releaseTerminalWorktreePathIndexLease('wt-1', '/repo', 'local')
    expect(cancelLoad).toHaveBeenCalledOnce()

    resolveList(['ghost.ts'])
    await listPromise
    await Promise.resolve()
    expect(
      lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/ghost.ts', 'local')
    ).toBeUndefined()
  })

  it('cancel then re-prime keeps the newer load; old finally does not clear it', async () => {
    let resolveOld!: (paths: string[]) => void
    let resolveNew!: (paths: string[]) => void
    const oldPromise = new Promise<string[]>((resolve) => {
      resolveOld = resolve
    })
    const newPromise = new Promise<string[]>((resolve) => {
      resolveNew = resolve
    })
    const cancelLoad = vi.fn()
    const listRelativePaths = vi
      .fn()
      .mockImplementationOnce(() => oldPromise)
      .mockImplementationOnce(() => newPromise)

    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths,
      cancelLoad
    })
    releaseTerminalWorktreePathIndexLease('wt-1', '/repo', 'local')
    expect(cancelLoad).toHaveBeenCalledOnce()

    primeTerminalWorktreePathIndex({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      ownerKey: 'local',
      listRelativePaths,
      cancelLoad
    })
    expect(listRelativePaths).toHaveBeenCalledTimes(2)

    resolveOld(['stale.ts'])
    await oldPromise
    await Promise.resolve()
    expect(
      lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/stale.ts', 'local')
    ).toBeUndefined()

    resolveNew(['fresh.ts'])
    await newPromise
    await Promise.resolve()
    expect(lookupWorktreeListedPathExists('wt-1', '/repo', '/repo/fresh.ts', 'local')).toBe(true)
  })
})
