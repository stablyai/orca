import { expect, it } from 'vitest'
import { loadGitHistoryFromExecutor } from './git-history-execution'
import { createRealGitHistoryFixture } from './git-history-real-git.test-fixture'

it('lists the commits ahead of the base without push status, statistics or range counts', async () => {
  const {
    root: directory,
    git,
    cleanup
  } = await createRealGitHistoryFixture('orca-branch-history-')
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
    await cleanup()
  }
})
