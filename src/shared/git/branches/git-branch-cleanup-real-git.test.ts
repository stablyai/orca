import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  branchHasNoUnmergedChangesOnAnyTarget,
  type GitBranchCleanupExec
} from './git-branch-cleanup'
import { GitCapabilityCache } from '../commands/git-capability-cache'
import { removeTree } from '../../windows-transient-lock-removal'

const execFileAsync = promisify(execFile)

describe('branch cleanup with real Git', () => {
  let root = ''
  let remote = ''

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
    await mkdir(remote)
    await git(remote, ['init', '-q'])
    await git(remote, ['config', 'user.name', 'Orca Test'])
    await git(remote, ['config', 'user.email', 'orca@example.invalid'])
    await git(remote, ['config', 'gc.auto', '0'])
    await commit(remote, 'base')
    await git(remote, ['branch', '-M', 'main'])
  })

  afterEach(async () => {
    await removeTree(root)
  })

  it.each([
    ['proves a squash-merged branch that merged main and whose lines main rewrote', true],
    ['preserves the same branch when main never squashed it', false]
  ])('%s', async (_label, squashed) => {
    const writeLines = (last: string) => writeFile(join(remote, 'lines.txt'), `a\nb\nc\n${last}\n`)
    await writeLines('d')
    await git(remote, ['add', 'lines.txt'])
    await git(remote, ['commit', '-qm', 'lines'])
    await git(remote, ['checkout', '-qb', 'feature'])
    await writeLines('feature')
    await git(remote, ['commit', '-qam', 'feature edit'])
    await git(remote, ['checkout', '-q', 'main'])
    await commit(remote, 'main-only')
    await git(remote, ['checkout', '-q', 'feature'])
    await git(remote, ['merge', '-q', '--no-edit', 'main'])
    await git(remote, ['checkout', '-q', 'main'])
    if (squashed) {
      await git(remote, ['merge', '-q', '--squash', 'feature'])
      await git(remote, ['commit', '-qm', 'squash feature'])
    }
    // A later edit to the same line makes a plain merge conflict, leaving only the patch-id search.
    await writeLines('main')
    await git(remote, ['commit', '-qam', 'main edit'])
    for (let index = 0; index < 3; index += 1) {
      await commit(remote, `after-${index}`)
    }

    // patch-id reads its diff from stdin; a conflicted merge-tree still reports its stdout.
    const runGit: GitBranchCleanupExec = (args, options) =>
      new Promise((resolve, reject) => {
        const child = execFile('git', args, { cwd: remote }, (error, stdout) =>
          error ? reject(Object.assign(error, { stdout })) : resolve({ stdout })
        )
        child.stdin?.end(options?.stdin ?? '')
      })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(
        runGit,
        'feature',
        ['refs/heads/main'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(squashed)
  })
})
