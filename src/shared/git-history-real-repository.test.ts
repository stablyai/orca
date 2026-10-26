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
  const git = async (args: string[], cwd = repo, date = '2000-01-04T00:00:00Z', input?: string) => {
    const result = await runProcess({
      program: gitBinary,
      args,
      cwd,
      input,
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
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
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
  it('shows unmerged local and remote branches in date order, rather than hiding them behind one ancestry', async () => {
    const { repo, git } = await createRepository()
    const executor = (args: string[], cwd: string, stdin?: string) =>
      git(args, cwd, undefined, stdin)
    await git(['checkout', '-b', 'feature', 'first~1'])
    await git(
      ['commit', '--quiet', '--allow-empty', '-m', 'Unmerged feature'],
      repo,
      '2000-01-05T00:00:00Z'
    )
    await git(['update-ref', 'refs/remotes/origin/feature', 'HEAD'])
    await git(['checkout', 'first'])
    await git(
      ['commit', '--quiet', '--allow-empty', '-m', 'Latest main'],
      repo,
      '2000-01-06T00:00:00Z'
    )
    await git(['update-ref', 'refs/remotes/origin/old', 'first~1'])
    await git(['update-ref', 'refs/remotes/origin/base', 'first~2'])
    const current = await loadGitHistoryFromExecutor(executor, repo, { scope: 'current' })
    expect(current.items.map((item) => item.subject)).toEqual(['Latest main', 'A', 'B'])
    const all = await loadGitHistoryFromExecutor(executor, repo, { scope: 'all' })
    expect(all.items.slice(0, 3).map((item) => item.subject)).toEqual([
      'Latest main',
      'Unmerged feature',
      'V'
    ])
    expect(all.items).toHaveLength(5)
    const rows = buildGitHistoryViewModels(
      all.items,
      buildDefaultGitHistoryColorMap(all),
      all.currentRef
    )
    expect(
      rows.find((row) => row.historyItem.subject === 'Unmerged feature')?.outputSwimlanes
    ).toHaveLength(2)
    expect(
      rows
        .find((row) => row.historyItem.subject === 'Unmerged feature')
        ?.historyItem.references?.every((ref) => Boolean(ref.color))
    ).toBe(true)
    const first = await loadGitHistoryFromExecutor(executor, repo, { scope: 'all', limit: 2 })
    expect(first.nextCursor?.revisions.length).toBeGreaterThan(3)
    await git(['branch', '-D', 'feature'])
    await git(['update-ref', '-d', 'refs/remotes/origin/feature'])
    const second = await loadGitHistoryFromExecutor(executor, repo, {
      cursor: first.nextCursor,
      limit: 20
    })
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      all.items.map((item) => item.id)
    )
  }, 30000)

  it('pages past 50 commits with a stable graph while branch tips move', async () => {
    const { repo, git } = await createRepository()
    await git(['checkout', '-b', 'comparison', 'first~1'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Comparison branch'])
    await git(['checkout', 'first'])
    const start = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    const commits = Array.from({ length: 55 }, (_, index) => {
      const message = `Commit ${index}`
      return `commit refs/heads/first\ncommitter Graph Fixture <graph-fixture@example.test> ${946944000 + index} +0000\ndata ${message.length}\n${message}\n${index === 0 ? `from ${start}\n` : ''}\n`
    }).join('')
    await git(['fast-import', '--quiet'], repo, undefined, `${commits}done\n`)
    const options = { scope: 'all' as const, baseRef: 'comparison' }
    const full = await loadGitHistoryFromExecutor(git, repo, { ...options, limit: 200 })
    const first = await loadGitHistoryFromExecutor(git, repo, { ...options, limit: 11 })
    const items = [...first.items]
    let cursor = first.nextCursor
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Created after snapshot'])
    await git(['update-ref', 'refs/heads/comparison', 'HEAD'])
    while (cursor) {
      const page = await loadGitHistoryFromExecutor(git, repo, { limit: 11, cursor })
      expect(page.items.length).toBeLessThanOrEqual(11)
      items.push(...page.items)
      cursor = page.nextCursor
    }
    expect(items.map((item) => item.id)).toEqual(full.items.map((item) => item.id))
    expect(items).toHaveLength(full.items.length)
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
    const rows = buildGitHistoryViewModels(items)
    expect(rows.some((row) => row.inputSwimlanes.length > 1)).toBe(true)
    expect(rows.at(-1)?.outputSwimlanes).toEqual([])
    expect(buildGitHistoryViewModels(first.items)).toEqual(rows.slice(0, first.items.length))
  }, 30000)

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
