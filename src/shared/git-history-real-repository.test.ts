import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { resolveExecutableCommand } from './node-cli-command-resolution'
import { loadGitHistoryFromExecutor } from './git-history'
import { buildDefaultGitHistoryColorMap, buildGitHistoryViewModels } from './git-history-graph'

const repositories: string[] = []
const gitBinary = resolveExecutableCommand(process.env.ORCA_TEST_GIT_BINARY ?? 'git')

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repo) => rm(repo, { recursive: true, force: true }))
  )
})

async function createRepository(inheritedEnv: NodeJS.ProcessEnv = process.env) {
  if (!gitBinary) {
    throw new Error('Git is required for the real history regression')
  }
  const repo = await mkdtemp(join(tmpdir(), 'orca-history-roots-'))
  repositories.push(repo)
  const emptyConfig = join(repo, 'empty-git-config')
  const emptyHooks = join(repo, 'empty-hooks')
  await writeFile(emptyConfig, '')
  await mkdir(emptyHooks)
  const fixtureEnv = Object.fromEntries(
    Object.entries(inheritedEnv).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
  )
  const git = async (args: string[], cwd = repo, date = '2000-01-04T00:00:00Z') => {
    const result = await runProcess({
      program: gitBinary,
      args,
      cwd,
      env: {
        ...fixtureEnv,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date
      },
      timeoutMs: 10000,
      maxOutputBytes: 1024 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      // Stderr on its own line, as Git's own errors read, so fatal-prefix checks see it.
      throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`)
    }
    return { stdout: result.stdout }
  }
  await git(['init', '--quiet'])
  await git(['config', 'user.name', 'Graph Fixture'])
  await git(['config', 'user.email', 'graph-fixture@example.test'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['config', 'core.hooksPath', emptyHooks])
  await git(['checkout', '-b', 'first'])
  await git(['commit', '--quiet', '--allow-empty', '-m', 'B'], repo, '2000-01-01T00:00:00Z')
  await git(['commit', '--quiet', '--allow-empty', '-m', 'A'], repo, '2000-01-02T00:00:00Z')
  await git(['checkout', '--orphan', 'unrelated'])
  await git(['commit', '--quiet', '--allow-empty', '-m', 'V'], repo, '2000-01-03T00:00:00Z')
  return { repo, git }
}

describe('real unrelated Git histories', () => {
  it.each(['repository pointers', 'config overrides'] as const)(
    'ignores inherited Git %s when creating a fixture',
    async (contamination) => {
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
      )
      const caller = await createRepository(cleanEnv)
      await caller.git(['config', 'user.name', 'Caller Repository'])
      const protectedPaths = ['HEAD', 'config', 'index'].map((name) =>
        join(caller.repo, '.git', name)
      )
      const before = await Promise.all(protectedPaths.map((path) => readFile(path)))
      const refsBefore = (await caller.git(['show-ref'])).stdout
      const inheritedGitEnv =
        contamination === 'repository pointers'
          ? {
              GIT_DIR: join(caller.repo, '.git'),
              GIT_WORK_TREE: caller.repo,
              GIT_COMMON_DIR: join(caller.repo, '.git'),
              GIT_INDEX_FILE: join(caller.repo, '.git', 'index'),
              GIT_OBJECT_DIRECTORY: join(caller.repo, '.git', 'objects'),
              GIT_ALTERNATE_OBJECT_DIRECTORIES: join(caller.repo, '.git', 'objects')
            }
          : {
              GIT_CONFIG: join(caller.repo, '.git', 'config'),
              GIT_CONFIG_PARAMETERS: "'user.name=Injected Author'",
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'core.bare',
              GIT_CONFIG_VALUE_0: 'true'
            }
      const fixture = await createRepository({ ...cleanEnv, ...inheritedGitEnv })

      expect(
        await realpath((await fixture.git(['rev-parse', '--show-toplevel'])).stdout.trim())
      ).toBe(await realpath(fixture.repo))
      expect((await fixture.git(['log', '-1', '--format=%an <%ae>'])).stdout.trim()).toBe(
        'Graph Fixture <graph-fixture@example.test>'
      )
      expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before)
      expect((await caller.git(['show-ref'])).stdout).toBe(refsBefore)
    }
  )

  it.each([false, true])(
    'keeps the other history when first parent is a root: %s',
    async (firstParentIsRoot) => {
      const { repo, git } = await createRepository()
      if (!firstParentIsRoot) {
        await git(['checkout', 'first'])
      }
      await git([
        'merge',
        '--quiet',
        '--no-ff',
        '--allow-unrelated-histories',
        '-m',
        'M',
        firstParentIsRoot ? 'first' : 'unrelated'
      ])
      const history = await loadGitHistoryFromExecutor(git, repo, { limit: 10 })
      const rows = buildGitHistoryViewModels(
        history.items,
        buildDefaultGitHistoryColorMap(history),
        history.currentRef
      )
      const terminatingRoot = rows.find(
        (row) => row.historyItem.subject === (firstParentIsRoot ? 'B' : 'V')
      )!
      const surviving = history.items.find(
        (item) => item.subject === (firstParentIsRoot ? 'V' : 'A')
      )!

      expect(history.items).toHaveLength(4)
      expect(history.items[0]!.parentIds).toHaveLength(2)
      expect(terminatingRoot.historyItem.parentIds).toEqual([])
      expect(terminatingRoot.inputSwimlanes).toHaveLength(2)
      expect(terminatingRoot.outputSwimlanes.map((lane) => lane.id)).toEqual([surviving.id])
      const nextRow = rows[rows.indexOf(terminatingRoot) + 1]!
      expect(nextRow.inputSwimlanes.map((lane) => lane.id)).toEqual([surviving.id])
      expect(rows.at(-1)!.outputSwimlanes).toEqual([])

      const truncated = await loadGitHistoryFromExecutor(git, repo, { limit: 2 })
      expect(truncated.hasMore).toBe(true)
      expect(truncated.items).toHaveLength(2)
    }
  )
})

describe('real branch-only history', () => {
  it('stops at the base, marks commits the upstream has, and pages with skip', async () => {
    const { repo, git } = await createRepository()
    await git(['checkout', '--quiet', 'first'])
    await git(['checkout', '--quiet', '-b', 'feature'])
    await writeFile(join(repo, 'notes.txt'), 'one\ntwo\n')
    await git(['add', 'notes.txt'])
    await git(['commit', '--quiet', '-m', 'F1'])
    const pushedOid = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    await git(['remote', 'add', 'origin', join(repo, 'no-remote')])
    await git(['update-ref', 'refs/remotes/origin/feature', pushedOid])
    await git(['branch', '--quiet', '--set-upstream-to=origin/feature'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'F2'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'F3'])
    await git(['checkout', '--quiet', 'first'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'N1'])
    await git(['checkout', '--quiet', 'feature'])

    const options = { baseRef: 'first', branchOnly: true, limit: 2 }
    const page = await loadGitHistoryFromExecutor(git, repo, options)
    expect(page.items.map((item) => [item.subject, item.pushed])).toEqual([
      ['F3', false],
      ['F2', false]
    ])
    expect(page.branch).toMatchObject({ ahead: 3, behind: 1, unpushed: 2 })
    expect(page.branch?.baseRef.name).toBe('first')
    expect(page.hasMore).toBe(true)

    const next = await loadGitHistoryFromExecutor(git, repo, { ...options, skip: 2 })
    expect(next.skip).toBe(2)
    expect(next.hasMore).toBe(false)
    expect(next.items.map((item) => [item.subject, item.pushed, item.statistics])).toEqual([
      ['F1', true, { files: 1, insertions: 2, deletions: 0 }]
    ])

    const onBase = await loadGitHistoryFromExecutor(git, repo, { ...options, baseRef: 'feature' })
    expect(onBase.branch).toBeUndefined()
    expect(onBase.items.map((item) => item.subject)).toEqual(['F3', 'F2'])

    // A checkout of the base's own branch has nothing to cut out, however the base is spelled.
    await git(['update-ref', 'refs/remotes/origin/first', 'first'])
    await git(['checkout', '--quiet', 'first'])
    const onBaseBranch = await loadGitHistoryFromExecutor(git, repo, {
      ...options,
      baseRef: 'origin/first'
    })
    expect(onBaseBranch.branch).toBeUndefined()
    expect(onBaseBranch.items.map((item) => item.subject)).toEqual(['N1', 'A'])

    // With a remote named gh/team, gh/team/main is team/main's base, not its own branch.
    await git(['remote', 'add', 'gh/team', join(repo, 'no-remote')])
    await git(['update-ref', 'refs/remotes/gh/team/main', 'first'])
    await git(['checkout', '--quiet', '-b', 'team/main'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'T1'])
    const slashRemote = await loadGitHistoryFromExecutor(git, repo, {
      ...options,
      baseRef: 'gh/team/main'
    })
    expect(slashRemote.items.map((item) => item.subject)).toEqual(['T1'])

    // Pushed with `git push origin HEAD` and no tracking branch: pushed state follows the
    // same effective upstream as git.upstreamStatus.
    await git(['checkout', '--quiet', '-b', 'agent', 'first'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'A1'])
    await git(['update-ref', 'refs/remotes/origin/agent', 'HEAD'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'A2'])
    const untracked = await loadGitHistoryFromExecutor(git, repo, options)
    expect(untracked.items.map((item) => [item.subject, item.pushed])).toEqual([
      ['A2', false],
      ['A1', true]
    ])
    expect(untracked.branch).toMatchObject({ ahead: 2, unpushed: 1 })
  })
})
