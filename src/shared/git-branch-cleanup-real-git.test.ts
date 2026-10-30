import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  branchHasNoUnmergedChangesOnAnyTarget,
  refreshBranchCleanupTargetRefs,
  type GitBranchCleanupExec
} from './git-branch-cleanup'
import { GitCapabilityCache } from './git-capability-cache'
import { removeTree } from './windows-transient-lock-removal'

const execFileAsync = promisify(execFile)

describe('branch cleanup with real Git', () => {
  let root = ''
  let remote = ''
  let client = ''

  const git = (cwd: string, args: string[]) =>
    execFileAsync('git', ['-c', 'commit.gpgSign=false', ...args], { cwd })
  const commit = async (cwd: string, name: string) => {
    await writeFile(join(cwd, name), name)
    await git(cwd, ['add', name])
    await git(cwd, ['commit', '-qm', name])
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-branch-cleanup-')))
    remote = join(root, 'remote')
    client = join(root, 'client')
    await mkdir(remote)
    await git(remote, ['init', '-q'])
    await git(remote, ['config', 'user.name', 'Orca Test'])
    await git(remote, ['config', 'user.email', 'orca@example.invalid'])
    await git(remote, ['config', 'gc.auto', '0'])
    await commit(remote, 'base')
    await git(remote, ['branch', '-M', 'main'])
    await git(remote, ['checkout', '-qb', 'unrelated-feature'])
    await commit(remote, 'feature')
    await git(remote, ['checkout', '-q', 'main'])
    await git(root, ['clone', '-q', remote, client])
  })

  afterEach(async () => {
    await removeTree(root)
  })

  it('refreshes the requested base without fetching other branches or new tags', async () => {
    const previousFeature = (await git(client, ['rev-parse', 'origin/unrelated-feature'])).stdout
    await git(remote, ['checkout', '-q', 'unrelated-feature'])
    await commit(remote, 'new-feature')
    await git(remote, ['tag', 'new-feature-tag'])
    await git(remote, ['checkout', '-q', 'main'])
    await commit(remote, 'new-base')

    const refreshed = await refreshBranchCleanupTargetRefs(
      (args) => git(client, args),
      ['refs/remotes/origin/main']
    )

    expect(refreshed).toEqual(['refs/remotes/origin/main'])
    expect((await git(client, ['rev-parse', 'origin/main'])).stdout).toBe(
      (await git(remote, ['rev-parse', 'main'])).stdout
    )
    expect((await git(client, ['rev-parse', 'origin/unrelated-feature'])).stdout).toBe(
      previousFeature
    )
    expect((await git(client, ['tag', '--list'])).stdout).toBe('')
    const unrelatedCommit = (await git(remote, ['rev-parse', 'unrelated-feature'])).stdout.trim()
    await expect(git(client, ['cat-file', '-e', unrelatedCommit])).rejects.toThrow()
  })

  it('preserves shallow branches whose common ancestor is outside the clone', async () => {
    await commit(remote, 'new-main')
    const shallow = join(root, 'shallow')
    await git(root, ['clone', '-q', '--depth=1', pathToFileURL(remote).href, shallow])
    await git(shallow, [
      'fetch',
      '-q',
      '--depth=1',
      'origin',
      'refs/heads/unrelated-feature:refs/heads/feature'
    ])
    const commands: string[][] = []
    const runGit: GitBranchCleanupExec = (args) => {
      commands.push(args)
      return git(shallow, args)
    }

    expect((await git(shallow, ['rev-parse', '--is-shallow-repository'])).stdout.trim()).toBe(
      'true'
    )
    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(runGit, 'feature', ['HEAD'], new GitCapabilityCache())
    ).resolves.toBe(false)
    expect(commands.some((args) => args[0] === 'merge-tree')).toBe(false)
    expect((await git(shallow, ['show', 'feature:feature'])).stdout).toBe('feature')
  })

  it.each([
    ['exact', '+refs/heads/unrelated-feature:refs/remotes/origin/main', 'refs/remotes/origin/main'],
    [
      'wildcard',
      '+refs/heads/unrelated-*:refs/remotes/origin/base-*',
      'refs/remotes/origin/base-feature'
    ]
  ])('refreshes renamed tracking refs with an %s mapping', async (_label, refspec, target) => {
    await git(client, ['config', 'remote.origin.fetch', refspec])
    await git(remote, ['checkout', '-q', 'unrelated-feature'])
    await commit(remote, 'new-feature')

    const refreshed = await refreshBranchCleanupTargetRefs((args) => git(client, args), [target])

    expect(refreshed).toEqual([target])
    expect((await git(client, ['rev-parse', target])).stdout).toBe(
      (await git(remote, ['rev-parse', 'unrelated-feature'])).stdout
    )
  })

  it('preserves a tracking ref when its configured source is ambiguous', async () => {
    const previousMain = (await git(client, ['rev-parse', 'origin/main'])).stdout
    await git(client, [
      'config',
      '--add',
      'remote.origin.fetch',
      '+refs/heads/unrelated-feature:refs/remotes/origin/main'
    ])
    await commit(remote, 'new-main')

    await expect(
      refreshBranchCleanupTargetRefs((args) => git(client, args), ['refs/remotes/origin/main'])
    ).resolves.toEqual([])
    expect((await git(client, ['rev-parse', 'origin/main'])).stdout).toBe(previousMain)
  })

  it('does not bypass negative fetch mappings', async () => {
    const previousFeature = (await git(client, ['rev-parse', 'origin/unrelated-feature'])).stdout
    await git(client, ['config', '--add', 'remote.origin.fetch', '^refs/heads/unrelated-*'])
    await git(remote, ['checkout', '-q', 'unrelated-feature'])
    await commit(remote, 'excluded-feature')

    await expect(
      refreshBranchCleanupTargetRefs(
        (args) => git(client, args),
        ['refs/remotes/origin/unrelated-feature']
      )
    ).resolves.toEqual([])
    expect((await git(client, ['rev-parse', 'origin/unrelated-feature'])).stdout).toBe(
      previousFeature
    )
  })

  it('refreshes a live fallback base when the saved base was deleted upstream', async () => {
    const previousMain = (await git(client, ['rev-parse', 'origin/main'])).stdout.trim()
    await git(client, ['update-ref', 'refs/remotes/origin/deleted-base', previousMain])
    await commit(remote, 'new-main')

    await expect(
      refreshBranchCleanupTargetRefs(
        (args) => git(client, args),
        ['refs/remotes/origin/deleted-base', 'refs/remotes/origin/main']
      )
    ).resolves.toEqual(['refs/remotes/origin/main'])
    expect((await git(client, ['rev-parse', 'origin/main'])).stdout).toBe(
      (await git(remote, ['rev-parse', 'main'])).stdout
    )
  })
})
