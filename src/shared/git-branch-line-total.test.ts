import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildGitBranchLineTotalDiffArgs,
  invalidateGitBranchLineTotalInFlight,
  computeGitBranchLineTotal,
  GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS,
  GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS,
  isGitBranchLineTotalMergeBase,
  readGitBranchLineTotalMergeBaseParam,
  sumGitBranchLineTotal
} from './git-branch-line-total'
import type { GitLineStats } from './git-uncommitted-line-stats'

const MERGE_BASE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'
const OTHER_MERGE_BASE = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'

function statsMap(entries: Record<string, GitLineStats>): ReadonlyMap<string, GitLineStats> {
  return new Map(Object.entries(entries))
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

const tempRoots: string[] = []

async function createWorktreeDir(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-branch-line-total-'))
  tempRoots.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFile(path.join(root, relativePath), contents)
  }
  return root
}

beforeEach(() => {
  invalidateGitBranchLineTotalInFlight()
})

afterEach(async () => {
  invalidateGitBranchLineTotalInFlight()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('sumGitBranchLineTotal', () => {
  it('counts binary entries as zero rather than NaN', () => {
    expect(
      sumGitBranchLineTotal({
        mergeBase: MERGE_BASE,
        tracked: statsMap({
          'blob.bin': { added: undefined, removed: undefined },
          'src/a.ts': { added: 4, removed: 1 }
        }),
        untracked: statsMap({})
      })
    ).toEqual({ added: 4, removed: 1, mergeBase: MERGE_BASE })
  })

  it('counts a half-binary entry on the side git did report', () => {
    expect(
      sumGitBranchLineTotal({
        mergeBase: MERGE_BASE,
        tracked: statsMap({ 'odd.txt': { added: 3 } }),
        untracked: statsMap({ 'new.bin': {} })
      })
    ).toEqual({ added: 3, removed: 0, mergeBase: MERGE_BASE })
  })

  it('adds untracked additions on top of the tracked range and echoes the merge base', () => {
    expect(
      sumGitBranchLineTotal({
        mergeBase: MERGE_BASE,
        tracked: statsMap({ 'src/a.ts': { added: 10, removed: 2 } }),
        untracked: statsMap({ 'src/new.ts': { added: 7, removed: 0 }, 'src/also.ts': { added: 1 } })
      })
    ).toEqual({ added: 18, removed: 2, mergeBase: MERGE_BASE })
  })

  it('returns an all-zero total for a pure rename rather than omitting it', () => {
    expect(
      sumGitBranchLineTotal({
        mergeBase: MERGE_BASE,
        tracked: statsMap({ 'g.txt': { added: 0, removed: 0 } }),
        untracked: statsMap({})
      })
    ).toEqual({ added: 0, removed: 0, mergeBase: MERGE_BASE })
  })
})

describe('merge base param validation', () => {
  it('accepts abbreviated and full object names', () => {
    for (const value of ['abc1234', MERGE_BASE, 'f'.repeat(64)]) {
      expect(isGitBranchLineTotalMergeBase(value)).toBe(true)
      expect(readGitBranchLineTotalMergeBaseParam(value)).toBe(value)
    }
  })

  it('rejects anything that is not an object name, notably flag-shaped input', () => {
    const rejected: unknown[] = [
      '--upload-pack=x',
      '-M',
      'HEAD',
      '',
      'origin/main',
      'A1B2C3D',
      'abc123',
      'f'.repeat(65),
      'abc1234 --output=/tmp/x',
      undefined,
      null,
      42,
      { toString: () => MERGE_BASE }
    ]
    for (const value of rejected) {
      expect(isGitBranchLineTotalMergeBase(value)).toBe(false)
      expect(readGitBranchLineTotalMergeBaseParam(value)).toBeUndefined()
    }
  })
})

describe('buildGitBranchLineTotalDiffArgs', () => {
  it('diffs the merge base against the working tree with -M only', () => {
    expect(buildGitBranchLineTotalDiffArgs(MERGE_BASE)).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '-z',
      '--numstat',
      '-M',
      MERGE_BASE,
      '--'
    ])
  })

  it('never asks for --cached or -C, which would change the measured range', () => {
    const args = buildGitBranchLineTotalDiffArgs(MERGE_BASE)
    expect(args).not.toContain('--cached')
    expect(args).not.toContain('-C')
    expect(args.at(-1)).toBe('--')
  })

  it('exposes a finite timeout budget so a huge branch cannot block the status response', () => {
    expect(GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS)).toBe(true)
  })
})

describe('computeGitBranchLineTotal', () => {
  it('never invokes git for a merge base that is not an object name', async () => {
    const runDiffNumstat = vi.fn()
    for (const mergeBase of ['--upload-pack=x', 'HEAD', '', 'origin/main']) {
      await expect(
        computeGitBranchLineTotal({
          worktreePath: '/repo',
          hostKey: 'native',
          mergeBase,
          untrackedPaths: [],
          runDiffNumstat
        })
      ).resolves.toBeUndefined()
    }
    expect(runDiffNumstat).not.toHaveBeenCalled()
  })

  it('includes untracked additions the ranged diff cannot see', async () => {
    const worktreePath = await createWorktreeDir({ 'new.txt': 'one\ntwo\nthree\n' })

    await expect(
      computeGitBranchLineTotal({
        worktreePath,
        hostKey: 'native',
        mergeBase: MERGE_BASE,
        untrackedPaths: ['new.txt'],
        runDiffNumstat: async () => '4\t1\tsrc/a.ts\0'
      })
    ).resolves.toEqual({ added: 7, removed: 1, mergeBase: MERGE_BASE })
  })

  it('omits the total when the ranged numstat fails instead of publishing untracked-only zeros', async () => {
    const worktreePath = await createWorktreeDir({ 'new.txt': 'one\ntwo\n' })

    await expect(
      computeGitBranchLineTotal({
        worktreePath,
        hostKey: 'native',
        mergeBase: MERGE_BASE,
        untrackedPaths: ['new.txt'],
        runDiffNumstat: async () => {
          throw new Error('fatal: bad object')
        }
      })
    ).resolves.toBeUndefined()
  })

  it('coalesces concurrent callers sharing a host, worktree and merge base into one exec', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runDiffNumstat = vi.fn(async () => {
      await gate
      return '4\t1\tsrc/a.ts\0'
    })
    const input = {
      worktreePath: '/repo',
      hostKey: 'native',
      mergeBase: MERGE_BASE,
      untrackedPaths: [],
      runDiffNumstat
    }

    const both = Promise.all([computeGitBranchLineTotal(input), computeGitBranchLineTotal(input)])
    release()

    expect(await both).toEqual([
      { added: 4, removed: 1, mergeBase: MERGE_BASE },
      { added: 4, removed: 1, mergeBase: MERGE_BASE }
    ])
    expect(runDiffNumstat).toHaveBeenCalledTimes(1)
  })

  it('keeps separate execs for a different merge base, worktree or host', async () => {
    const runDiffNumstat = vi.fn(async () => '1\t0\tsrc/a.ts\0')
    const base = {
      worktreePath: '/repo',
      hostKey: 'native',
      mergeBase: MERGE_BASE,
      untrackedPaths: [],
      runDiffNumstat
    }

    await Promise.all([
      computeGitBranchLineTotal(base),
      computeGitBranchLineTotal({ ...base, mergeBase: OTHER_MERGE_BASE }),
      computeGitBranchLineTotal({ ...base, worktreePath: '/other-repo' }),
      computeGitBranchLineTotal({ ...base, hostKey: 'Ubuntu' })
    ])

    expect(runDiffNumstat).toHaveBeenCalledTimes(4)
  })

  it('re-execs once the shared lease has settled', async () => {
    const runDiffNumstat = vi.fn(async () => '1\t0\tsrc/a.ts\0')
    const input = {
      worktreePath: '/repo',
      hostKey: 'native',
      mergeBase: MERGE_BASE,
      untrackedPaths: [],
      runDiffNumstat
    }

    await computeGitBranchLineTotal(input)
    await computeGitBranchLineTotal(input)

    expect(runDiffNumstat).toHaveBeenCalledTimes(2)
  })

  it('rejects when the shared diff is aborted instead of resolving a partial total', async () => {
    const controller = new AbortController()
    const runDiffNumstat = vi.fn(
      (_args: string[], signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(createAbortError()), { once: true })
        })
    )

    const pending = computeGitBranchLineTotal({
      worktreePath: '/repo',
      hostKey: 'native',
      mergeBase: MERGE_BASE,
      untrackedPaths: [],
      runDiffNumstat,
      signal: controller.signal
    })
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await assertion
  })

  it('rejects immediately for a signal that is already aborted', async () => {
    const runDiffNumstat = vi.fn(async () => '1\t0\tsrc/a.ts\0')

    await expect(
      computeGitBranchLineTotal({
        worktreePath: '/repo',
        hostKey: 'native',
        mergeBase: MERGE_BASE,
        untrackedPaths: [],
        runDiffNumstat,
        signal: AbortSignal.abort()
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(runDiffNumstat).not.toHaveBeenCalled()
  })

  it('passes the built argv straight through to the runner', async () => {
    const runDiffNumstat = vi.fn(async () => '')

    await computeGitBranchLineTotal({
      worktreePath: '/repo',
      hostKey: 'native',
      mergeBase: MERGE_BASE,
      untrackedPaths: [],
      runDiffNumstat
    })

    expect(runDiffNumstat).toHaveBeenCalledWith(
      buildGitBranchLineTotalDiffArgs(MERGE_BASE),
      expect.anything()
    )
  })

  it('invalidateGitBranchLineTotalInFlight stops a later pass joining a pre-mutation diff', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runDiffNumstat = vi.fn(async () => {
      await gate
      return '1\t0\tsrc/a.ts\0'
    })
    const input = {
      worktreePath: '/repo',
      hostKey: 'native',
      mergeBase: MERGE_BASE,
      untrackedPaths: [],
      runDiffNumstat
    }

    const first = computeGitBranchLineTotal(input)
    invalidateGitBranchLineTotalInFlight()
    const second = computeGitBranchLineTotal(input)
    release()
    await Promise.all([first, second])

    expect(runDiffNumstat).toHaveBeenCalledTimes(2)
  })
})

describe('computeGitBranchLineTotal ranged-diff cooldown', () => {
  let nowMs = 0

  function diffTaking(durationMs: number): () => Promise<string> {
    return vi.fn(async () => {
      nowMs += durationMs
      return '10\t2\tsrc/a.ts\0'
    })
  }

  function inputFor(
    runDiffNumstat: () => Promise<string>,
    worktreePath = '/repo'
  ): Parameters<typeof computeGitBranchLineTotal>[0] {
    return {
      worktreePath,
      hostKey: 'native',
      mergeBase: MERGE_BASE,
      untrackedPaths: [],
      runDiffNumstat
    }
  }

  const TOTAL = { added: 10, removed: 2, mergeBase: MERGE_BASE }

  beforeEach(() => {
    nowMs = 0
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips a rerun for as long as the overrunning diff itself took', async () => {
    const runDiffNumstat = diffTaking(900)
    const input = inputFor(runDiffNumstat)

    await expect(computeGitBranchLineTotal(input)).resolves.toEqual(TOTAL)
    await expect(computeGitBranchLineTotal(input)).resolves.toBeUndefined()
    expect(runDiffNumstat).toHaveBeenCalledTimes(1)

    nowMs += 900
    await expect(computeGitBranchLineTotal(input)).resolves.toEqual(TOTAL)
    expect(runDiffNumstat).toHaveBeenCalledTimes(2)
  })

  it('leaves a diff inside the soft deadline uncooled, so ordinary repos are untouched', async () => {
    const runDiffNumstat = diffTaking(GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS - 1)
    const input = inputFor(runDiffNumstat)

    await expect(computeGitBranchLineTotal(input)).resolves.toEqual(TOTAL)
    await expect(computeGitBranchLineTotal(input)).resolves.toEqual(TOTAL)
    expect(runDiffNumstat).toHaveBeenCalledTimes(2)
  })

  it('arms the cooldown on a failing diff too, since a timeout is the costliest outcome', async () => {
    const runDiffNumstat = vi.fn(async () => {
      nowMs += GIT_BRANCH_LINE_TOTAL_TIMEOUT_MS
      throw new Error('timed out')
    })
    const input = inputFor(runDiffNumstat)

    await expect(computeGitBranchLineTotal(input)).resolves.toBeUndefined()
    await expect(computeGitBranchLineTotal(input)).resolves.toBeUndefined()
    expect(runDiffNumstat).toHaveBeenCalledTimes(1)
  })

  it('clears the cooldown on a git mutation, when a fresh total matters most', async () => {
    const runDiffNumstat = diffTaking(900)
    const input = inputFor(runDiffNumstat)

    await expect(computeGitBranchLineTotal(input)).resolves.toEqual(TOTAL)
    invalidateGitBranchLineTotalInFlight()
    await expect(computeGitBranchLineTotal(input)).resolves.toEqual(TOTAL)
    expect(runDiffNumstat).toHaveBeenCalledTimes(2)
  })

  it('cools down per worktree, so one slow branch cannot mute another', async () => {
    const slow = diffTaking(900)
    const other = diffTaking(900)

    await expect(computeGitBranchLineTotal(inputFor(slow, '/repo'))).resolves.toEqual(TOTAL)
    await expect(computeGitBranchLineTotal(inputFor(slow, '/repo'))).resolves.toBeUndefined()
    await expect(computeGitBranchLineTotal(inputFor(other, '/other'))).resolves.toEqual(TOTAL)

    expect(slow).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(1)
  })
})
