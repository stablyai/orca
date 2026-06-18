import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  syncForkDefaultBranch,
  validateGitForkSyncExpectedUpstream,
  type GitForkSyncRunner
} from './git-fork-sync'

afterEach(() => {
  vi.restoreAllMocks()
})

function createRunner(overrides: {
  remotes?: string
  upstreamUrl?: string
  defaultBranchOutput?: string
  originExists?: boolean
  upstreamExists?: boolean
  aheadBehind?: string
}): { runGit: GitForkSyncRunner; calls: string[][] } {
  const calls: string[][] = []
  const runGit = vi.fn(async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: overrides.upstreamUrl ?? 'git@github.com:stablyai/orca.git\n' }
    }
    if (args[0] === 'remote') {
      return { stdout: overrides.remotes ?? 'origin\nupstream\n' }
    }
    if (args[0] === 'ls-remote') {
      return {
        stdout:
          overrides.defaultBranchOutput ??
          'ref: refs/heads/main\tHEAD\n0123456789012345678901234567890123456789\tHEAD\n'
      }
    }
    if (args[0] === 'rev-parse') {
      const ref = args[2] ?? ''
      if (ref.includes('origin/main') && overrides.originExists === false) {
        throw new Error('missing origin branch')
      }
      if (ref.includes('upstream/main') && overrides.upstreamExists === false) {
        throw new Error('missing upstream branch')
      }
      return {
        stdout: ref.includes('upstream')
          ? '2222222222222222222222222222222222222222\n'
          : '1111111111111111111111111111111111111111\n'
      }
    }
    if (args[0] === 'rev-list') {
      return { stdout: overrides.aheadBehind ?? '0\t2\n' }
    }
    return { stdout: '' }
  })
  return { runGit, calls }
}

function flattenedCommands(calls: string[][]): string {
  return calls.map((args) => args.join(' ')).join('\n')
}

describe('syncForkDefaultBranch', () => {
  it('pushes the upstream default branch when the fork is only behind', async () => {
    const { runGit, calls } = createRunner({ aheadBehind: '0\t3\n' })

    const result = await syncForkDefaultBranch(runGit)

    expect(result).toMatchObject({ status: 'synced', branchName: 'main', ahead: 0, behind: 3 })
    expect(calls).toContainEqual([
      'push',
      'origin',
      '2222222222222222222222222222222222222222:refs/heads/main'
    ])
    expect(calls).toContainEqual([
      'fetch',
      '--no-tags',
      '--prune',
      'upstream',
      '+refs/heads/main:refs/remotes/upstream/main'
    ])
  })

  it('supports default branch names with slashes', async () => {
    const { runGit, calls } = createRunner({
      defaultBranchOutput:
        'ref: refs/heads/release/1.0\tHEAD\n0123456789012345678901234567890123456789\tHEAD\n',
      aheadBehind: '0\t1\n'
    })

    await syncForkDefaultBranch(runGit)

    expect(calls).toContainEqual([
      'push',
      'origin',
      '2222222222222222222222222222222222222222:refs/heads/release/1.0'
    ])
  })

  it('does nothing when the fork default branch already matches upstream', async () => {
    const { runGit, calls } = createRunner({ aheadBehind: '0\t0\n' })

    const result = await syncForkDefaultBranch(runGit)

    expect(result).toMatchObject({ status: 'up-to-date', branchName: 'main' })
    expect(flattenedCommands(calls)).not.toContain('push origin')
  })

  it('scans newline-heavy remote and default-branch output without line-array splitting', async () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const { runGit } = createRunner({
      remotes: `${'\r\n'.repeat(10_000)}origin\r\nupstream\r\n`,
      defaultBranchOutput: `${'metadata\r\n'.repeat(
        10_000
      )}ref: refs/heads/main\tHEAD\r\n0123456789012345678901234567890123456789\tHEAD\r\n`,
      aheadBehind: '0\t0\n'
    })

    await expect(syncForkDefaultBranch(runGit)).resolves.toMatchObject({
      status: 'up-to-date',
      branchName: 'main'
    })

    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && separator === '\n') ||
        (separator instanceof RegExp && separator.source === '\\r?\\n')
    )
    expect(usedLineSplit).toBe(false)
  })

  it('blocks when the fork has commits that are not upstream', async () => {
    const { runGit, calls } = createRunner({ aheadBehind: '2\t4\n' })

    const result = await syncForkDefaultBranch(runGit)

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'diverged',
      ahead: 2,
      behind: 4
    })
    const commands = flattenedCommands(calls)
    expect(commands).not.toContain('push origin')
    expect(commands).not.toContain('reset --hard')
    expect(commands).not.toContain('pull')
    expect(commands).not.toContain('rebase')
    expect(commands).not.toContain('force')
  })

  it('blocks when the upstream remote is missing', async () => {
    const { runGit } = createRunner({ remotes: 'origin\n' })

    await expect(syncForkDefaultBranch(runGit)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'missing-upstream'
    })
  })

  it('blocks when the upstream remote no longer matches the expected fork metadata', async () => {
    const { runGit, calls } = createRunner({
      upstreamUrl: 'git@github.com:someone-else/orca.git\n'
    })

    await expect(
      syncForkDefaultBranch(runGit, {
        expectedUpstream: { owner: 'stablyai', repo: 'orca' }
      })
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'upstream-mismatch'
    })
    expect(flattenedCommands(calls)).not.toContain('fetch')
    expect(flattenedCommands(calls)).not.toContain('push')
  })

  it('blocks when a non-GitHub upstream remote has the expected owner and repo suffix', async () => {
    const { runGit, calls } = createRunner({
      upstreamUrl: 'ssh://evil.example.com/stablyai/orca.git\n'
    })

    await expect(
      syncForkDefaultBranch(runGit, {
        expectedUpstream: { owner: 'stablyai', repo: 'orca' }
      })
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'upstream-mismatch'
    })
    expect(flattenedCommands(calls)).not.toContain('fetch')
    expect(flattenedCommands(calls)).not.toContain('push')
  })

  it('rejects malformed expected upstream metadata instead of disabling identity validation', async () => {
    const { runGit } = createRunner({})

    await expect(
      syncForkDefaultBranch(runGit, {
        expectedUpstream: { owner: '   ', repo: 'orca' }
      })
    ).rejects.toThrow('Invalid expected upstream.')
  })

  it('rejects missing expected upstream metadata when required by a boundary', () => {
    expect(() => validateGitForkSyncExpectedUpstream(undefined, { required: true })).toThrow(
      'Expected upstream is required.'
    )
  })

  it('blocks when origin lacks the upstream default branch', async () => {
    const { runGit } = createRunner({ originExists: false })

    await expect(syncForkDefaultBranch(runGit)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'missing-origin-branch',
      branchName: 'main'
    })
  })
})
