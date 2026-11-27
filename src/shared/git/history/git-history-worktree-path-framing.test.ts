import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { resolveExecutableCommand } from '../../shell/command-resolution/node-cli-command-resolution'
import { loadGitHistoryRefs } from './git-history-revisions'

it.skipIf(process.platform === 'win32')(
  'retains newline worktree paths in the history ref catalog',
  async () => {
    const executable = resolveExecutableCommand(process.env.ORCA_TEST_GIT_BINARY ?? 'git')
    if (!executable) {
      throw new Error('Git is required for the history pathname regression')
    }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-history-path-')))
    const repo = join(root, 'repo')
    const linked = join(root, 'review\nworkspace')
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'no-global-git-config')
    }
    const git = async (args: string[], cwd = repo, input?: string) => {
      const result = await runProcess({
        program: executable,
        args,
        cwd,
        env,
        ...(input === undefined ? {} : { input }),
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024
      })
      if (result.code !== 0 || result.timedOut || result.outputTruncated) {
        throw new Error(`Git failed: ${result.stderr}`)
      }
      return { stdout: result.stdout }
    }
    try {
      await mkdir(repo)
      await git(['init', '--quiet'])
      await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
      await git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--allow-empty',
        '--quiet',
        '-m',
        'Initial'
      ])
      await git(['worktree', 'add', '--quiet', '-b', 'feature', linked])
      expect(
        (await loadGitHistoryRefs(git, repo)).map(({ id, worktreePath }) => ({ id, worktreePath }))
      ).toEqual([
        { id: 'refs/heads/feature', worktreePath: linked },
        { id: 'refs/heads/main', worktreePath: repo }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
