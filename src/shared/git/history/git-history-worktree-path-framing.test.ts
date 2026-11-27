import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createRealGitHistoryFixture } from './git-history-real-git.test-fixture'
import { loadGitHistoryRefs } from './git-history-revisions'

it.skipIf(process.platform === 'win32')(
  'retains newline worktree paths in the history ref catalog',
  async () => {
    const { root, git, cleanup } = await createRealGitHistoryFixture('orca-history-path-')
    const repo = join(root, 'repo')
    const linked = join(root, 'review\nworkspace')
    try {
      await mkdir(repo)
      await git(['init', '--quiet'], repo)
      await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo)
      await git(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '--allow-empty',
          '--quiet',
          '-m',
          'Initial'
        ],
        repo
      )
      await git(['worktree', 'add', '--quiet', '-b', 'feature', linked], repo)
      expect(
        (await loadGitHistoryRefs(git, repo)).map(({ id, worktreePath }) => ({ id, worktreePath }))
      ).toEqual([
        { id: 'refs/heads/feature', worktreePath: linked },
        { id: 'refs/heads/main', worktreePath: repo }
      ])
    } finally {
      await cleanup()
    }
  }
)
