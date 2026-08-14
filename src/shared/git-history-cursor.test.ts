import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GitHistoryCursor, GitHistoryExecutor } from './git-history'
import { loadGitHistoryFromExecutor } from './git-history'

const execFileAsync = promisify(execFile)

function oid(index: number): string {
  return index.toString(16).padStart(40, '0')
}

// The fake chain is linear, so row N's only parent is row N+1.
function seam(index: number): { id: string; parentIds: string[] } {
  return { id: oid(index), parentIds: [oid(index + 1)] }
}

function logRecord(hash: string, message: string, parents: string[]): string {
  return `${[hash, 'Ada Lovelace', 'ada@example.com', '1700000000', '1700000000', parents.join(' '), '', message].join('\n')}\0`
}

/**
 * Fake of a linear history that honours `-n` and `--skip`.
 *
 * Deliberately only used for request shape and the stale-anchor degrade. A fake cannot model
 * `--topo-order` over a DAG, and pretending it can is what let an unsound cursor look correct —
 * the walk properties are asserted against the real git binary below.
 */
function createWalkExecutor(
  total: number,
  { knownOids }: { knownOids?: Set<string> } = {}
): { executor: GitHistoryExecutor; logCalls: string[][] } {
  const chain = Array.from({ length: total }, (_, index) => oid(index))
  const logCalls: string[][] = []

  const executor = vi.fn(async (args: string[]) => {
    const command = args[0]
    if (command === 'rev-parse') {
      const target = args.find((arg) => arg.endsWith('^{commit}'))?.replace('^{commit}', '')
      if (target === 'HEAD') {
        return { stdout: `${chain[0]}\n` }
      }
      // Why: models an anchor that no longer resolves (rebased away, pruned).
      if (target && knownOids && !knownOids.has(target)) {
        throw new Error(`unknown revision ${target}`)
      }
      return target && chain.includes(target) ? { stdout: `${target}\n` } : { stdout: '' }
    }
    if (command === 'symbolic-ref') {
      return { stdout: 'main\n' }
    }
    if (command === 'for-each-ref' || command === 'merge-base') {
      return { stdout: '' }
    }
    if (command === 'log') {
      logCalls.push(args)
      const count = Number(args.find((arg) => arg.startsWith('-n'))?.slice(2) ?? total)
      const skip = Number(args.find((arg) => arg.startsWith('--skip='))?.slice(7) ?? 0)
      const start = args.at(-1) ?? ''
      const from = chain.indexOf(start)
      const base = (from === -1 ? 0 : from) + skip
      return {
        stdout: chain
          .slice(base, base + count)
          .map((hash) =>
            logRecord(hash, `commit ${chain.indexOf(hash)}`, [chain[chain.indexOf(hash) + 1] ?? ''])
          )
          .join('')
      }
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`)
  })

  return { executor, logCalls }
}

describe('git history cursor paging', () => {
  it('walks from HEAD and offers a cursor when more remains', async () => {
    const { executor, logCalls } = createWalkExecutor(200)

    const result = await loadGitHistoryFromExecutor(executor, '/repo', { limit: 50 })

    expect(result.items).toHaveLength(50)
    expect(result.items[0]?.id).toBe(oid(0))
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toEqual({ anchor: oid(0), loaded: 50, after: seam(49) })
    // one lookahead past the page, and no offset on the first page
    expect(logCalls[0]).toContain('-n51')
    expect(logCalls[0]?.some((arg) => arg.startsWith('--skip='))).toBe(false)
  })

  it('resumes at the cursor offset without repeating the previous page', async () => {
    const { executor, logCalls } = createWalkExecutor(200)

    const page = await loadGitHistoryFromExecutor(executor, '/repo', {
      limit: 50,
      cursor: { anchor: oid(0), loaded: 50, after: seam(49) }
    })

    expect(page.items[0]?.id).toBe(oid(50))
    expect(page.items.map((item) => item.id)).not.toContain(oid(49))
    expect(page.items).toHaveLength(50)
    expect(page.nextCursor).toEqual({ anchor: oid(0), loaded: 100, after: seam(99) })
    // Why: skip stops one short of the page so the walk re-emits the seam row, and the count
    // covers that row, the page, and one lookahead.
    expect(logCalls[0]).toContain('--skip=49')
    expect(logCalls[0]).toContain('-n52')
  })

  // Why: this is the property the whole design turns on — page cost must not grow with depth.
  it('asks for one page of output no matter how deep paging goes', async () => {
    const { executor, logCalls } = createWalkExecutor(1000)

    for (const loaded of [50, 300, 900]) {
      await loadGitHistoryFromExecutor(executor, '/repo', {
        limit: 50,
        cursor: { anchor: oid(0), loaded, after: seam(loaded - 1) }
      })
    }

    expect(
      logCalls.map((args) => Number(args.find((arg) => arg.startsWith('-n'))?.slice(2)))
    ).toEqual([52, 52, 52])
  })

  it('reports no further page, and no cursor, at the end of history', async () => {
    const { executor } = createWalkExecutor(60)

    const page = await loadGitHistoryFromExecutor(executor, '/repo', {
      limit: 50,
      cursor: { anchor: oid(0), loaded: 50, after: seam(49) }
    })

    expect(page.items).toHaveLength(10)
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeUndefined()
  })

  it('pages past the old 200-commit ceiling', async () => {
    const { executor } = createWalkExecutor(1000)

    const deep = await loadGitHistoryFromExecutor(executor, '/repo', {
      limit: 50,
      cursor: { anchor: oid(0), loaded: 200, after: seam(199) }
    })

    expect(deep.items[0]?.id).toBe(oid(200))
    expect(deep.hasMore).toBe(true)
  })

  // Why: an anchor can die under a rebase. Degrading to a fresh first page keeps the panel usable;
  // passing the dead revision to `git log` would fail the whole read.
  it('falls back to a fresh first page when the anchor no longer resolves', async () => {
    const { executor, logCalls } = createWalkExecutor(200, {
      knownOids: new Set(Array.from({ length: 100 }, (_, index) => oid(index)))
    })

    const page = await loadGitHistoryFromExecutor(executor, '/repo', {
      limit: 50,
      cursor: { anchor: oid(150), loaded: 150, after: seam(149) }
    })

    expect(page.items[0]?.id).toBe(oid(0))
    // Why: the offset belongs to the dead walk, so it must be dropped with it — carrying it over
    // would skip the first 150 commits of the fresh page.
    expect(logCalls[0]?.some((arg) => arg.startsWith('--skip='))).toBe(false)
    expect(page.nextCursor).toEqual({ anchor: oid(0), loaded: 50, after: seam(49) })
  })
})

/**
 * Paging semantics against the real git binary.
 *
 * A commit-id cursor passes every fake above and still loses commits here: restarting the walk at
 * the oldest row reaches only that commit's ancestors, so a merged long-lived branch drops the
 * mainline commits above the fork point and paging stops early reporting nothing more to load.
 */
describe('git history paging against a real repository', () => {
  let repoPath = ''
  let allCommits: string[] = []

  const git: GitHistoryExecutor = async (args, cwd) => {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
    return { stdout }
  }

  beforeAll(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'orca-git-history-paging-'))
    const run = async (args: string[]): Promise<void> => {
      await execFileAsync('git', args, {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ada',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_COMMITTER_NAME: 'Ada',
          GIT_COMMITTER_EMAIL: 'ada@example.com'
        }
      })
    }
    let tick = 0
    // `lane` keeps each line of history on its own file so the merge below is conflict-free.
    const commit = async (message: string, lane = 'base'): Promise<void> => {
      tick += 1
      await writeFile(join(repoPath, `${lane}.txt`), `${message}\n`)
      await run(['add', '-A'])
      const when = `2020-01-01T00:00:${String(tick % 60).padStart(2, '0')}`
      await execFileAsync('git', ['commit', '-q', '-m', message], {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ada',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_COMMITTER_NAME: 'Ada',
          GIT_COMMITTER_EMAIL: 'ada@example.com',
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_DATE: when
        }
      })
    }

    // `git init -b` is Git 2.28; the project baseline is 2.25. Naming the branch through
    // symbolic-ref works on every supported Git and ignores the user's init.defaultBranch.
    await run(['init', '-q', '.'])
    await run(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await commit('base')
    // A long-lived branch: both lines of history grow past a page before being merged, so a page
    // boundary necessarily lands inside one of them while the other is still unshown.
    await run(['branch', 'feature'])
    for (let index = 1; index <= 12; index += 1) {
      await commit(`main-${index}`, 'main')
    }
    await run(['checkout', '-q', 'feature'])
    for (let index = 1; index <= 12; index += 1) {
      await commit(`feat-${index}`, 'feat')
    }
    await run(['checkout', '-q', 'main'])
    await run(['merge', '-q', '--no-ff', 'feature', '-m', 'Merge feature'])

    const { stdout } = await execFileAsync('git', ['rev-list', '--topo-order', 'HEAD'], {
      cwd: repoPath
    })
    allCommits = stdout.trim().split('\n')
  }, 60_000)

  afterAll(async () => {
    if (repoPath) {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  async function pageThrough(limit: number): Promise<string[]> {
    const seen: string[] = []
    let cursor: GitHistoryCursor | undefined
    // Bound the loop so a paging bug fails on the assertions below rather than hanging.
    for (let page = 0; page < 50; page += 1) {
      const result = await loadGitHistoryFromExecutor(git, repoPath, { limit, cursor })
      seen.push(...result.items.map((item) => item.id))
      if (!result.hasMore || !result.nextCursor) {
        break
      }
      cursor = result.nextCursor
    }
    return seen
  }

  it('reaches every commit across a merge, in one uninterrupted topo order', async () => {
    expect(allCommits.length).toBe(26)

    const paged = await pageThrough(10)

    // Why: identity, not set equality — a page boundary must neither drop a parallel line of
    // history nor reorder one, so the paged sequence is the single-walk sequence.
    expect(paged).toEqual(allCommits)
  })

  it('ends paging only when git has nothing older, whatever the page size', async () => {
    for (const limit of [1, 3, 7, 25]) {
      expect(await pageThrough(limit)).toEqual(allCommits)
    }
  })

  it('keeps every page the same size as paging goes deeper', async () => {
    const sizes: number[] = []
    let cursor: GitHistoryCursor | undefined
    for (let page = 0; page < 50; page += 1) {
      const result = await loadGitHistoryFromExecutor(git, repoPath, { limit: 5, cursor })
      sizes.push(result.items.length)
      if (!result.hasMore || !result.nextCursor) {
        break
      }
      cursor = result.nextCursor
    }
    // Why: the payload is what the SSH and relay transports cap at 1MB, so page size must not
    // grow with depth the way re-requesting a larger window from HEAD did.
    expect(sizes.slice(0, -1).every((size) => size === 5)).toBe(true)
  })

  it('degrades to a fresh first page when the anchor is not a known commit', async () => {
    const result = await loadGitHistoryFromExecutor(git, repoPath, {
      limit: 5,
      cursor: { anchor: 'f'.repeat(40), loaded: 20, after: { id: 'e'.repeat(40), parentIds: [] } }
    })

    expect(result.items.map((item) => item.id)).toEqual(allCommits.slice(0, 5))
    // Why: the client tells a restart from a continuation by this, and only by this — without it
    // a fresh page 1 gets appended under the commits already on screen.
    expect(result.continuedCursor).toBe(false)
  })

  // Why: an anchor resolving is not proof its ancestry is unchanged. `git replace --graft` rewrites
  // a commit's parents in place, so the same anchor can walk a different history between two page
  // requests — and an unverified resume would splice that history in, skipping and reordering rows.
  it('restarts rather than splicing when the walk under the anchor changed', async () => {
    const first = await loadGitHistoryFromExecutor(git, repoPath, { limit: 5 })
    const cursor = first.nextCursor
    expect(cursor).toBeDefined()

    const graftTarget = first.items[1]?.id ?? ''
    expect(graftTarget).not.toBe(first.items.at(-1)?.id)
    const orphanParent = allCommits.at(-1) ?? ''
    await execFileAsync('git', ['replace', '--graft', graftTarget, orphanParent], { cwd: repoPath })
    try {
      const drifted = await loadGitHistoryFromExecutor(git, repoPath, {
        limit: 5,
        cursor: cursor as NonNullable<typeof cursor>
      })

      expect(drifted.continuedCursor).toBe(false)
      // A restart is a fresh page 1 of the walk as it now stands, which the client replaces with.
      const { stdout } = await execFileAsync('git', ['rev-list', '--topo-order', '-n5', 'HEAD'], {
        cwd: repoPath
      })
      expect(drifted.items.map((item) => item.id)).toEqual(stdout.trim().split('\n'))
    } finally {
      await execFileAsync('git', ['replace', '-d', graftTarget], { cwd: repoPath })
    }
  })

  // Why: the seam keeping its id is not enough. Grafting the seam commit itself leaves the id at
  // the same walk offset while replacing everything below it, so an id-only check would splice the
  // grafted chain under a row whose drawn parent edge points at a commit the list no longer holds.
  it('restarts when the seam keeps its id but its parents were rewritten', async () => {
    const first = await loadGitHistoryFromExecutor(git, repoPath, { limit: 5 })
    const cursor = first.nextCursor
    expect(cursor).toBeDefined()

    const seamId = first.items.at(-1)?.id ?? ''
    const orphanParent = allCommits.at(-1) ?? ''
    expect(seamId).toBe(cursor?.after.id)
    await execFileAsync('git', ['replace', '--graft', seamId, orphanParent], { cwd: repoPath })
    try {
      const drifted = await loadGitHistoryFromExecutor(git, repoPath, {
        limit: 5,
        cursor: cursor as NonNullable<typeof cursor>
      })

      // The seam is still the first row of the resumed read, so only the parent check can catch it.
      expect(drifted.continuedCursor).toBe(false)
    } finally {
      await execFileAsync('git', ['replace', '-d', seamId], { cwd: repoPath })
    }
  })

  // Why: this is what pinning the walk buys, and nothing else in the suite can see it. HEAD moving
  // mid-paging is routine here — agents commit in terminals while the panel is open. Re-anchoring
  // each page to the live HEAD shifts the offset under the walk, so pages silently repeat commits
  // at the near end and drop exactly as many off the far end.
  it('keeps later pages on the walk the first page started, when HEAD moves mid-paging', async () => {
    const first = await loadGitHistoryFromExecutor(git, repoPath, { limit: 5 })
    expect(first.nextCursor).toBeDefined()

    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'landed mid-paging'], {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Ada',
        GIT_AUTHOR_EMAIL: 'ada@example.com',
        GIT_COMMITTER_NAME: 'Ada',
        GIT_COMMITTER_EMAIL: 'ada@example.com'
      }
    })
    try {
      const seen = first.items.map((item) => item.id)
      let cursor = first.nextCursor
      while (cursor) {
        const next = await loadGitHistoryFromExecutor(git, repoPath, { limit: 5, cursor })
        expect(next.continuedCursor).toBe(true)
        seen.push(...next.items.map((item) => item.id))
        cursor = next.hasMore ? next.nextCursor : undefined
      }

      expect(new Set(seen).size).toBe(seen.length)
      expect(seen).toEqual(allCommits)
    } finally {
      await execFileAsync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: repoPath })
    }
  })
})
