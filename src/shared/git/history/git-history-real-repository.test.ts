import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { resolveExecutableCommand } from '../../node-cli-command-resolution'

import { gitHistoryTokens } from './git-history-token-store'
import { loadGitHistoryRefs } from './git-history-revisions'
import { loadGitHistoryFromExecutor } from './git-history-execution'

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
    const usesStdin = args.includes('--stdin') || args[0] === 'cat-file'
    const result = await runProcess({
      ...(usesStdin ? { input: date } : {}),
      program: gitBinary,
      args,
      cwd,
      env: {
        ...fixtureEnv,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_AUTHOR_DATE: usesStdin ? '2000-01-04T00:00:00Z' : date,
        GIT_COMMITTER_DATE: usesStdin ? '2000-01-04T00:00:00Z' : date
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

describe('filtered and pinned history', () => {
  it('walks only branch, remote and commit-pointing tag roots, including unborn HEAD', async () => {
    const { repo, git } = await createRepository()
    await git(['checkout', '--quiet', '--detach'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'remote only'])
    await git(['update-ref', 'refs/remotes/origin/other', 'HEAD'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'stash only'])
    await git(['update-ref', 'refs/stash', 'HEAD'])
    await git(['checkout', '--quiet', '--detach', 'first'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'pull only'])
    await git(['update-ref', 'refs/pull/1/head', 'HEAD'])
    await git(['checkout', '--quiet', '--detach', 'first'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'tag only'])
    await git(['tag', '-a', 'inner', '-m', 'inner'])
    await git(['tag', '-a', 'outer', 'inner', '-m', 'outer'])
    await git(['tag', 'tree', 'HEAD^{tree}'])
    await git(['symbolic-ref', 'refs/remotes/origin/alias', 'refs/remotes/origin/other'])
    await git(['checkout', '--quiet', 'first'])
    const refs = await loadGitHistoryRefs(git, repo)
    expect(refs.map((ref) => ref.id)).toEqual([
      'refs/heads/first',
      'refs/heads/unrelated',
      'refs/remotes/origin/other',
      'refs/tags/inner',
      'refs/tags/outer'
    ])
    const all = await loadGitHistoryFromExecutor(git, repo, { refs: 'all' })
    expect(all).not.toHaveProperty('resolvedRefs')
    expect(all.historyToken).toEqual(expect.any(String))
    expect(all.items.map((item) => item.subject).sort()).toEqual([
      'A',
      'B',
      'V',
      'remote only',
      'tag only'
    ])
    await git(['checkout', '--orphan', 'unborn'])
    const unborn = await loadGitHistoryFromExecutor(git, repo, { refs: 'all' })
    expect(unborn.items.map((item) => item.subject).sort()).toEqual([
      'A',
      'B',
      'V',
      'remote only',
      'tag only'
    ])
    const chosen = await loadGitHistoryFromExecutor(git, repo, { refs: ['refs/heads/unrelated'] })
    expect(chosen.items.map((item) => item.subject)).toEqual(['V'])
    expect(chosen.resolvedRefs).toEqual(['refs/heads/unrelated'])
    const tag = await loadGitHistoryFromExecutor(git, repo, {
      refs: ['refs/tags/outer', 'refs/tags/tree']
    })
    expect(tag.items.map((item) => item.subject)).toEqual(['tag only', 'A', 'B'])
    expect(tag.resolvedRefs).toEqual(['refs/tags/outer'])
  })

  it('keeps page two exact across branch movement and reports lost tokens', async () => {
    const { repo, git } = await createRepository()
    await git(['checkout', '--quiet', 'first'])
    const page = await loadGitHistoryFromExecutor(git, repo, { refs: 'all', limit: 1 })
    expect(page.items.map((item) => item.subject)).toEqual(['V'])
    await git(['commit', '--quiet', '--allow-empty', '-m', 'new'])
    const next = await loadGitHistoryFromExecutor(git, repo, {
      refs: 'all',
      historyToken: page.historyToken,
      skip: 1,
      limit: 2
    })
    expect(next.items.map((item) => item.subject)).toEqual(['A', 'B'])
    const wrongFilter = await loadGitHistoryFromExecutor(git, repo, {
      refs: 'head',
      historyToken: page.historyToken
    })
    expect(wrongFilter.historyChanged).toBe(true)
    for (let index = 0; index < 32; index++) {
      gitHistoryTokens.put(repo, 'all', [], [])
    }
    const evicted = await loadGitHistoryFromExecutor(git, repo, {
      refs: 'all',
      historyToken: page.historyToken
    })
    expect(evicted).toMatchObject({ items: [], historyChanged: true })
  })
})

it('keeps default history unpinned without evicting an explicitly pinned graph', async () => {
  const { repo, git } = await createRepository()
  const graph = await loadGitHistoryFromExecutor(git, repo, { refs: 'head', limit: 1 })
  expect(graph.historyToken).toEqual(expect.any(String))
  for (let i = 0; i < 40; i++) {
    const sidebar = await loadGitHistoryFromExecutor(git, repo)
    expect(sidebar.historyToken).toBeUndefined()
  }
  const next = await loadGitHistoryFromExecutor(git, repo, {
    refs: 'head',
    historyToken: graph.historyToken,
    skip: 1
  })
  expect(next.historyChanged).toBeUndefined()
})
