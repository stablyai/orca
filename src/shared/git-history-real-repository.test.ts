import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from './child-process/run-process'
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

async function createRepository() {
  if (!gitBinary) {
    throw new Error('Git is required for the real history regression')
  }
  const repo = await mkdtemp(join(tmpdir(), 'orca-history-roots-'))
  repositories.push(repo)
  const emptyConfig = join(repo, 'empty-git-config')
  const emptyHooks = join(repo, 'empty-hooks')
  await writeFile(emptyConfig, '')
  await mkdir(emptyHooks)
  const git = async (args: string[], cwd = repo, date = '2000-01-04T00:00:00Z') => {
    const result = await runProcess({
      program: gitBinary,
      args,
      cwd,
      env: {
        ...process.env,
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
