import { describe, expect, it, vi } from 'vitest'
import {
  createGitConfigSnapshotRunner,
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

describe('createGitConfigSnapshotRunner', () => {
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
})
