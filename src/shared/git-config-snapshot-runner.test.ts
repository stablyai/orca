import { describe, expect, it, vi } from 'vitest'
import {
  createGitConfigSnapshotRunner,
  GitConfigSnapshotKeyNotFoundError
} from './git-config-snapshot-runner'

function listSnapshot(records: string[]): string {
  return `${records.join('\0')}\0`
}

function getGitArgs(call: unknown[]): string[] {
  return call[0] as string[]
}

function countCalls(runGit: ReturnType<typeof vi.fn>, expectedArgs: string[]): number {
  return runGit.mock.calls.filter((call) => {
    const args = getGitArgs(call)
    return (
      args.length === expectedArgs.length && args.every((arg, index) => arg === expectedArgs[index])
    )
  }).length
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve
  })
  return { promise, resolve: resolveDeferred }
}

describe('createGitConfigSnapshotRunner', () => {
  it('serves many config --get lookups from one config --list -z call', async () => {
    const runGit = vi.fn(async () => ({
      stdout: listSnapshot([
        'branch.main.remote\norigin',
        'branch.main.merge\nrefs/heads/main',
        'remote.pushdefault\nfork'
      ])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await runner(['config', '--get', 'branch.main.remote'])
    await runner(['config', '--get', 'branch.main.merge'])
    await runner(['config', '--get', 'remote.pushDefault'])

    expect(countCalls(runGit, ['config', '--list', '-z'])).toBe(1)
    expect(runGit.mock.calls.filter((call) => getGitArgs(call)[1] === '--get')).toHaveLength(0)
  })

  it('returns branch and remote values from a representative snapshot', async () => {
    const runGit = vi.fn(async () => ({
      stdout: listSnapshot([
        'branch.feature.remote\norigin',
        'branch.feature.merge\nrefs/heads/feature',
        'remote.origin.url\ngit@example.com:org/repo.git'
      ])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'branch.feature.remote'])).resolves.toEqual({
      stdout: 'origin'
    })
    await expect(runner(['config', '--get', 'branch.feature.merge'])).resolves.toEqual({
      stdout: 'refs/heads/feature'
    })
    await expect(runner(['config', '--get', 'remote.origin.url'])).resolves.toEqual({
      stdout: 'git@example.com:org/repo.git'
    })
  })

  it('passes remote commands through unchanged', async () => {
    const runGit = vi.fn(async (args: string[]) => ({ stdout: args.join(' ') }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['remote'])).resolves.toEqual({ stdout: 'remote' })
    await expect(runner(['remote', 'get-url', 'origin'])).resolves.toEqual({
      stdout: 'remote get-url origin'
    })

    expect(countCalls(runGit, ['remote'])).toBe(1)
    expect(countCalls(runGit, ['remote', 'get-url', 'origin'])).toBe(1)
  })

  it('case-folds the requested section and key', async () => {
    const runGit = vi.fn(async () => ({
      stdout: listSnapshot(['remote.pushdefault\nfork'])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'remote.pushDefault'])).resolves.toEqual({
      stdout: 'fork'
    })
  })

  it('preserves subsections with dots in lookup keys', async () => {
    const runGit = vi.fn(async () => ({
      stdout: listSnapshot(['branch.feature.x.merge\nrefs/heads/feature.x'])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'branch.feature.x.merge'])).resolves.toEqual({
      stdout: 'refs/heads/feature.x'
    })
  })

  it('returns the last multivar value for config --get', async () => {
    const runGit = vi.fn(async () => ({
      stdout: listSnapshot([
        'branch.main.merge\nrefs/heads/old',
        'branch.main.merge\nrefs/heads/new'
      ])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'branch.main.merge'])).resolves.toEqual({
      stdout: 'refs/heads/new'
    })
  })

  it('parses valueless boolean keys without corrupting adjacent records', async () => {
    const runGit = vi.fn(async () => ({
      stdout: listSnapshot([
        'remote.origin.mirror',
        'remote.origin.url\ngit@example.com:org/repo.git'
      ])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'remote.origin.mirror'])).resolves.toEqual({
      stdout: ''
    })
    await expect(runner(['config', '--get', 'remote.origin.url'])).resolves.toEqual({
      stdout: 'git@example.com:org/repo.git'
    })
  })

  it('rejects an absent key from a loaded snapshot instead of returning empty success', async () => {
    // Why: real `git config --get` exits non-zero for a missing key; a loaded
    // snapshot must preserve that contract (not turn a miss into '' success),
    // and must NOT fall back to a real config --get (that would re-spawn the
    // subprocess this runner exists to coalesce away).
    const runGit = vi.fn(async () => ({
      stdout: listSnapshot(['branch.main.remote\norigin'])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'branch.main.merge'])).rejects.toThrow(
      GitConfigSnapshotKeyNotFoundError
    )
    // The miss is served from the loaded snapshot — no passthrough config --get.
    expect(countCalls(runGit, ['config', '--list', '-z'])).toBe(1)
    expect(
      runGit.mock.calls.filter((call) => {
        const args = getGitArgs(call)
        return args[0] === 'config' && args[1] === '--get'
      })
    ).toHaveLength(0)
  })

  it('single-flights concurrent first config --get lookups', async () => {
    const snapshot = createDeferred<{ stdout: string }>()
    const runGit = vi.fn(async () => await snapshot.promise)
    const runner = createGitConfigSnapshotRunner(runGit)

    const lookups = Promise.all([
      runner(['config', '--get', 'branch.main.remote']),
      runner(['config', '--get', 'branch.main.merge']),
      runner(['config', '--get', 'remote.pushDefault'])
    ])
    await Promise.resolve()

    expect(countCalls(runGit, ['config', '--list', '-z'])).toBe(1)
    snapshot.resolve({
      stdout: listSnapshot([
        'branch.main.remote\norigin',
        'branch.main.merge\nrefs/heads/main',
        'remote.pushdefault\nfork'
      ])
    })

    await expect(lookups).resolves.toEqual([
      { stdout: 'origin' },
      { stdout: 'refs/heads/main' },
      { stdout: 'fork' }
    ])
    expect(countCalls(runGit, ['config', '--list', '-z'])).toBe(1)
  })

  it('falls back to real config --get after snapshot fetch failure', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'config' && args[1] === '--list') {
        throw new Error('snapshot failed')
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return { stdout: `real:${args[2]}` }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'branch.main.remote'])).resolves.toEqual({
      stdout: 'real:branch.main.remote'
    })
    await expect(runner(['config', '--get', 'branch.main.merge'])).resolves.toEqual({
      stdout: 'real:branch.main.merge'
    })

    expect(countCalls(runGit, ['config', '--list', '-z'])).toBe(1)
    expect(runGit.mock.calls.filter((call) => getGitArgs(call)[1] === '--get')).toHaveLength(2)
  })

  it('passes non-config commands through', async () => {
    const runGit = vi.fn(async (args: string[]) => ({ stdout: args.join(' ') }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['rev-parse', '--abbrev-ref', 'HEAD@{u}'])).resolves.toEqual({
      stdout: 'rev-parse --abbrev-ref HEAD@{u}'
    })
    await expect(runner(['symbolic-ref', '--quiet', '--short', 'HEAD'])).resolves.toEqual({
      stdout: 'symbolic-ref --quiet --short HEAD'
    })

    expect(countCalls(runGit, ['rev-parse', '--abbrev-ref', 'HEAD@{u}'])).toBe(1)
    expect(countCalls(runGit, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toBe(1)
  })
})
