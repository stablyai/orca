import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { resolveExecutableCommand } from '../../shell/command-resolution/node-cli-command-resolution'
import { loadGitHistoryFromExecutor } from './git-history-execution'

it('lists the commits ahead of the base without push status, statistics or range counts', async () => {
  const executable = resolveExecutableCommand(process.env.ORCA_TEST_GIT_BINARY ?? 'git')
  if (!executable) {
    throw new Error('Git is required for the branch history regression')
  }
  const directory = await mkdtemp(join(tmpdir(), 'orca-branch-history-'))
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(directory, 'no-global-git-config')
  }
  const git = async (args: string[], cwd: string, input?: string) => {
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
      throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`)
    }
    return { stdout: result.stdout }
  }
  const commands: string[][] = []

  try {
    await git(['init', '--quiet'], directory)
    await git(
      ['fast-import', '--quiet'],
      directory,
      [
        'commit refs/heads/main',
        'mark :1',
        'committer Demo Author <demo@example.test> 946684800 +0000',
        'data 4',
        'Base',
        '',
        'reset refs/heads/published',
        'from :1',
        '',
        'commit refs/heads/feature',
        'committer Demo Author <demo@example.test> 946684900 +0000',
        'data 9',
        'Add notes',
        'from :1',
        'M 100644 inline notes.txt',
        'data 5',
        'notes',
        ''
      ].join('\n')
    )
    await git(['symbolic-ref', 'HEAD', 'refs/heads/feature'], directory)
    // A configured upstream is the route where the counts cost the most commands.
    await git(['config', 'branch.feature.remote', '.'], directory)
    await git(['config', 'branch.feature.merge', 'refs/heads/published'], directory)

    const recordingGit: typeof git = (args, cwd, input) => {
      commands.push(args)
      return git(args, cwd, input)
    }
    const page = await loadGitHistoryFromExecutor(recordingGit, directory, {
      baseRef: 'main',
      branchOnly: true,
      branchListOnly: true
    })

    expect(
      page.items.map(({ subject, pushed, statistics }) => [subject, pushed, statistics])
    ).toEqual([['Add notes', undefined, undefined]])
    // The menu reads only the base; ahead/behind/unpushed would cost range walks it never shows.
    expect(page.branch).toEqual({ baseRef: expect.objectContaining({ id: 'refs/heads/main' }) })
    expect(commands.filter(([command]) => command === 'rev-list')).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
