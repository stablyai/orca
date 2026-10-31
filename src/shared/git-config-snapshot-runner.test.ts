import { describe, expect, it, vi } from 'vitest'
import {
  createGitConfigSnapshotRunner,
  constructGitRemotePolicies,
  parseGitConfigOriginSnapshot,
  GitConfigSnapshotKeyNotFoundError
} from './git-config-snapshot-runner'

function listSnapshot(records: string[]): string {
  return `${records.join('\0')}\0`
}

type GitCommandRunner = Parameters<typeof createGitConfigSnapshotRunner>[0]

function countCalls(
  runGit: ReturnType<typeof vi.fn<GitCommandRunner>>,
  expectedArgs: string[]
): number {
  return runGit.mock.calls.filter(([args]) => {
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
    const runGit = vi.fn<GitCommandRunner>(async () => ({
      stdout: listSnapshot([
        'branch.main.remote\norigin',
        'branch.main.merge\nrefs/heads/main',
        'remote.pushdefault\nfork'
      ])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'branch.main.remote'])).resolves.toEqual({
      stdout: 'origin'
    })
    await expect(runner(['config', '--get', 'branch.main.merge'])).resolves.toEqual({
      stdout: 'refs/heads/main'
    })
    await expect(runner(['config', '--get', 'remote.pushDefault'])).resolves.toEqual({
      stdout: 'fork'
    })

    expect(countCalls(runGit, ['config', '--list', '-z'])).toBe(1)
    expect(runGit.mock.calls.filter(([args]) => args[1] === '--get')).toHaveLength(0)
  })

  it('returns branch and remote values from a representative snapshot', async () => {
    const runGit = vi.fn<GitCommandRunner>(async () => ({
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
    const runGit = vi.fn<GitCommandRunner>(async (args: string[]) => ({ stdout: args.join(' ') }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['remote'])).resolves.toEqual({ stdout: 'remote' })
    await expect(runner(['remote', 'get-url', 'origin'])).resolves.toEqual({
      stdout: 'remote get-url origin'
    })

    expect(countCalls(runGit, ['remote'])).toBe(1)
    expect(countCalls(runGit, ['remote', 'get-url', 'origin'])).toBe(1)
  })

  it('case-folds the requested section and key', async () => {
    const runGit = vi.fn<GitCommandRunner>(async () => ({
      stdout: listSnapshot(['remote.pushdefault\nfork'])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'REMOTE.pushDefault'])).resolves.toEqual({
      stdout: 'fork'
    })
  })

  it('preserves subsections with dots in lookup keys', async () => {
    const runGit = vi.fn<GitCommandRunner>(async () => ({
      stdout: listSnapshot(['branch.feature.x.merge\nrefs/heads/feature.x'])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'branch.feature.x.merge'])).resolves.toEqual({
      stdout: 'refs/heads/feature.x'
    })
  })

  it('returns the last multivar value for config --get', async () => {
    const runGit = vi.fn<GitCommandRunner>(async () => ({
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
    const runGit = vi.fn<GitCommandRunner>(async () => ({
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
    // Missing keys must reject like config --get, without respawning the command this snapshot coalesces.
    const runGit = vi.fn<GitCommandRunner>(async () => ({
      stdout: listSnapshot(['branch.main.remote\norigin'])
    }))
    const runner = createGitConfigSnapshotRunner(runGit)

    await expect(runner(['config', '--get', 'branch.main.merge'])).rejects.toThrow(
      GitConfigSnapshotKeyNotFoundError
    )
    expect(countCalls(runGit, ['config', '--list', '-z'])).toBe(1)
    expect(
      runGit.mock.calls.filter(([args]) => {
        return args[0] === 'config' && args[1] === '--get'
      })
    ).toHaveLength(0)
  })

  it('single-flights concurrent first config --get lookups', async () => {
    const snapshot = createDeferred<{ stdout: string }>()
    const runGit = vi.fn<GitCommandRunner>(async () => await snapshot.promise)
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
    const runGit = vi.fn<GitCommandRunner>(async (args: string[]) => {
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
    expect(runGit.mock.calls.filter(([args]) => args[1] === '--get')).toHaveLength(2)
  })

  it('passes non-config commands through', async () => {
    const runGit = vi.fn<GitCommandRunner>(async (args: string[]) => ({ stdout: args.join(' ') }))
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

it('retains native origin framing, case-sensitive subsections, valueless and empty multivars', () => {
  const output =
    'file:/repo/config\0remote.Mixed.Name.fetch\nrefs/heads/main\0file:/repo/private\0remote.Mixed.Name.fetch\nrefs/heads/main:refs/private/main\0command line:\0remote.Mixed.Name.orca-created\0file:/repo/private\0branch.Work.base\n\0'
  const parsed = parseGitConfigOriginSnapshot(output)
  expect(parsed.config.get('remote.Mixed.Name.fetch')).toEqual([
    'refs/heads/main',
    'refs/heads/main:refs/private/main'
  ])
  expect(parsed.origins[2].value).toBeNull()
  expect(parsed.origins[3].value).toBe('')
  expect(parsed.booleans.get('remote.Mixed.Name.orca-created')).toBe(true)
  expect(parsed.booleans.get('branch.Work.base')).toBe(false)
  expect(() => parseGitConfigOriginSnapshot('file:/bad\0')).toThrow('Incomplete')
})

it.each([58, 580])(
  'constructs native policy from %i legacy rows without changing authority vectors',
  (size) => {
    const original = Object.freeze(['refs/heads/config:refs/private/config'])
    const config = new Map([['remote.manual.fetch', original]])
    const before = JSON.stringify([...config])
    const lines = Array.from(
      { length: size },
      (_, i) => `Pull: +refs/heads/topic${i}:refs/private/topic${i}\r`
    )
    const stores = [
      [
        {
          name: 'manual',
          file: '/git/remotes/manual',
          kind: 'file' as const,
          contents: `URL: /fork\r\n${lines.join('\n')}\nPull: refs/heads/config:refs/private/config\n`
        }
      ],
      []
    ]
    const built = constructGitRemotePolicies(config, stores, 'manual')
    expect(built.policy.get('manual')?.get('fetch')).toEqual([
      ...original,
      ...lines.map((line) => line.slice(6).trimEnd()),
      ...original
    ])
    expect(built.policy.get('manual')?.get('fetch')).not.toBe(original)
    expect(JSON.stringify([...config])).toBe(before)
    const suppressed = constructGitRemotePolicies(
      new Map([...config, ['remote.manual.url', ['/configured']]]),
      stores
    )
    expect(suppressed.policy.get('manual')?.get('fetch')).toEqual(original)
    expect(suppressed.legacy.has('manual')).toBe(false)
    expect(constructGitRemotePolicies(config, stores, 'other').policy.has('manual')).toBe(false)
  }
)
