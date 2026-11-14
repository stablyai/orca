import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateGitBranchLineTotalInFlight,
  computeGitBranchLineTotal
} from './git-branch-line-total'

const MERGE_BASE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'
const NO_LINES = { added: 0, removed: 0 }

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
    ).resolves.toEqual({
      added: 7,
      removed: 1,
      mergeBase: MERGE_BASE,
      test: NO_LINES,
      generated: NO_LINES
    })
  })

  it('invalidates the total when ranged numstat fails instead of publishing untracked-only zeros', async () => {
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
    ).resolves.toBeNull()
  })

  it.each([
    ['deleted base path', '0\t2\trecreated.txt\0'],
    ['rename source', '0\t0\t\0recreated.txt\0renamed.txt\0']
  ])('marks an untracked overlap with a %s unavailable', async (_case, numstat) => {
    const worktreePath = await createWorktreeDir({ 'recreated.txt': 'one\nchanged\n' })
    await expect(
      computeGitBranchLineTotal({
        worktreePath,
        hostKey: 'native',
        mergeBase: MERGE_BASE,
        untrackedPaths: ['recreated.txt'],
        runDiffNumstat: async () => numstat
      })
    ).resolves.toBeNull()
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

  const TOTAL = {
    added: 10,
    removed: 2,
    mergeBase: MERGE_BASE,
    test: NO_LINES,
    generated: NO_LINES
  }

  beforeEach(() => {
    nowMs = 0
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('clears the cooldown on a git mutation, when a fresh total matters most', async () => {
    const runDiffNumstat = diffTaking(900)
    const input = inputFor(runDiffNumstat)

    await expect(computeGitBranchLineTotal(input)).resolves.toEqual(TOTAL)
    invalidateGitBranchLineTotalInFlight()
    await expect(computeGitBranchLineTotal(input)).resolves.toEqual(TOTAL)
    expect(runDiffNumstat).toHaveBeenCalledTimes(2)
  })
})
