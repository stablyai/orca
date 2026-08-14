import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitLineBlameResult } from '../../../shared/git-line-blame-types'

const mocks = vi.hoisted(() => ({
  getRuntimeGitLineBlame: vi.fn(),
  getRuntimeGitFileBlame: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitLineBlame: mocks.getRuntimeGitLineBlame,
  getRuntimeGitFileBlame: mocks.getRuntimeGitFileBlame
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ settingsForRuntimeOwner: () => ({}) }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))

const {
  blameKey,
  cachedLineBlame,
  clearLineBlameCache,
  requestLineBlame,
  resetLineBlameRequestsForTests,
  subscribeToLineBlame
} = await import('./line-blame-request')

function target(line: number): Parameters<typeof requestLineBlame>[0] {
  return {
    worktreeId: 'wt-1',
    filePath: `/repo/src/index.ts`,
    relativePath: 'src/index.ts',
    worktreePath: '/repo',
    runtimeEnvironmentId: null,
    line
  }
}

function blame(author: string): GitLineBlameResult {
  return { sha: 'a'.repeat(40), author, authorTimeMs: 1, summary: 's', isUncommitted: false }
}

afterEach(() => {
  resetLineBlameRequestsForTests()
  mocks.getRuntimeGitLineBlame.mockReset()
  mocks.getRuntimeGitFileBlame.mockReset()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}

describe('whole-file blame', () => {
  it('reads the file once and then answers every line without touching git', async () => {
    // Why this matters: `-L` does not make git blame cheaper, so a per-line
    // design pays the full history walk on every cursor move.
    mocks.getRuntimeGitFileBlame.mockResolvedValue({ 5: blame('Neil'), 40: blame('Ada') })

    requestLineBlame(target(5))
    await settle()
    requestLineBlame(target(40))
    await settle()
    requestLineBlame(target(5))
    await settle()

    expect(mocks.getRuntimeGitFileBlame).toHaveBeenCalledTimes(1)
    expect(mocks.getRuntimeGitLineBlame).not.toHaveBeenCalled()
    expect(cachedLineBlame(blameKey(target(40)))?.author).toBe('Ada')
  })

  it('reads the file once when both surfaces ask before it resolves', async () => {
    // Why: the entry is recorded before the read resolves, so a second surface
    // asking mid-flight must await it rather than firing a per-line blame — on a
    // large file that redundant walk costs as much as the whole-file read.
    let resolveFile: ((value: Record<number, GitLineBlameResult> | null) => void) | undefined
    mocks.getRuntimeGitFileBlame.mockImplementation(
      () => new Promise((resolve) => (resolveFile = resolve))
    )

    requestLineBlame(target(5))
    requestLineBlame(target(40))
    expect(mocks.getRuntimeGitFileBlame).toHaveBeenCalledTimes(1)
    expect(mocks.getRuntimeGitLineBlame).not.toHaveBeenCalled()

    resolveFile?.({ 5: blame('Neil'), 40: blame('Ada') })
    await settle()

    expect(mocks.getRuntimeGitFileBlame).toHaveBeenCalledTimes(1)
    expect(mocks.getRuntimeGitLineBlame).not.toHaveBeenCalled()
  })

  it('does not re-attempt the whole-file walk once it came back empty', async () => {
    // An unsupported host or oversized file must not pay the walk per line.
    mocks.getRuntimeGitFileBlame.mockResolvedValue(null)
    mocks.getRuntimeGitLineBlame.mockResolvedValue(blame('Neil'))

    requestLineBlame(target(5))
    await settle()
    requestLineBlame(target(40))
    await settle()

    expect(mocks.getRuntimeGitFileBlame).toHaveBeenCalledTimes(1)
    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(2)
  })

  it('expires cached authorship so an outside commit cannot be shown forever', async () => {
    // Why: nothing in the renderer reports HEAD, so a commit/amend/rebase made
    // outside the editor changes a line's author without changing the path or
    // the dirty flag. Bounded staleness beats a confidently wrong author.
    mocks.getRuntimeGitFileBlame.mockResolvedValue({ 5: blame('Before') })
    requestLineBlame(target(5))
    await settle()
    const key = blameKey(target(5))
    expect(cachedLineBlame(key)?.author).toBe('Before')

    expect(cachedLineBlame(key, Date.now() + 61_000)).toBeNull()
  })

  it('drops an in-flight file read that finished after an invalidation', async () => {
    // The editor moved on (file switched, or the buffer was edited) while the
    // walk was running, so its authorship describes a revision already left.
    let resolveFile: ((value: Record<number, GitLineBlameResult> | null) => void) | undefined
    mocks.getRuntimeGitFileBlame.mockImplementation(
      () => new Promise((resolve) => (resolveFile = resolve))
    )

    requestLineBlame(target(5))
    clearLineBlameCache()
    resolveFile?.({ 5: blame('Stale') })
    await settle()

    expect(cachedLineBlame(blameKey(target(5)))).toBeNull()
  })

  it('never publishes an answer from a generation the editor has left', async () => {
    // Why: fencing only the cache write is not enough — an obsolete response
    // that still publishes paints stale authorship on the current file.
    const seen: string[] = []
    subscribeToLineBlame((a) => seen.push(a.result?.author ?? 'null'))
    let resolveFirst: ((value: GitLineBlameResult | null) => void) | undefined
    mocks.getRuntimeGitFileBlame.mockResolvedValue(null)
    mocks.getRuntimeGitLineBlame.mockImplementation(
      () => new Promise((resolve) => (resolveFirst = resolve))
    )

    requestLineBlame(target(5))
    await settle()
    clearLineBlameCache()
    resolveFirst?.(blame('Obsolete'))
    await settle()

    expect(seen).not.toContain('Obsolete')
  })

  it('lets a same-key request run again after an invalidation', async () => {
    // The suppression is only valid while the in-flight work is; otherwise a
    // save would show whatever the pre-save request returns, with no refresh.
    mocks.getRuntimeGitFileBlame.mockResolvedValue(null)
    let resolveFirst: ((value: GitLineBlameResult | null) => void) | undefined
    mocks.getRuntimeGitLineBlame.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    )
    mocks.getRuntimeGitLineBlame.mockImplementation(async () => blame('Fresh'))

    // Settle first so the per-line request is genuinely in flight — that is the
    // only state in which the duplicate suppression applies.
    requestLineBlame(target(5))
    await settle()
    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)

    clearLineBlameCache()
    requestLineBlame(target(5))
    await settle()
    resolveFirst?.(blame('Obsolete'))
    await settle()

    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(2)
    expect(cachedLineBlame(blameKey(target(5)))?.author).toBe('Fresh')
  })

  it('repairs an expired file with one whole-file walk, not one per line', async () => {
    // Why this matters: after expiry, falling back to per-line blame would pay a
    // full history walk for every newly visited line.
    let now = 1_000_000
    mocks.getRuntimeGitFileBlame.mockResolvedValue({ 5: blame('Neil'), 40: blame('Ada') })
    const realNow = Date.now
    Date.now = () => now

    requestLineBlame(target(5))
    await settle()
    expect(mocks.getRuntimeGitFileBlame).toHaveBeenCalledTimes(1)

    now += 61_000
    requestLineBlame(target(5))
    await settle()
    requestLineBlame(target(40))
    await settle()

    Date.now = realNow
    expect(mocks.getRuntimeGitFileBlame).toHaveBeenCalledTimes(2)
    expect(mocks.getRuntimeGitLineBlame).not.toHaveBeenCalled()
  })

  it('falls back to per-line when whole-file blame is unavailable', async () => {
    // An older remote host, or a file too large to buffer, returns null.
    mocks.getRuntimeGitFileBlame.mockResolvedValue(null)
    mocks.getRuntimeGitLineBlame.mockResolvedValue(blame('Neil'))

    requestLineBlame(target(5))
    await settle()

    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)
    expect(cachedLineBlame(blameKey(target(5)))?.author).toBe('Neil')
  })

  it('asks per-line for a line the file read could not attribute', async () => {
    // Uncommitted lines are deliberately not cached, so they still need a read.
    mocks.getRuntimeGitFileBlame.mockResolvedValue({ 5: blame('Neil') })
    mocks.getRuntimeGitLineBlame.mockResolvedValue(null)

    requestLineBlame(target(40))
    await settle()

    expect(mocks.getRuntimeGitFileBlame).toHaveBeenCalledTimes(1)
    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)
  })
})

describe('requestLineBlame', () => {
  it('runs one git blame when both surfaces ask for the same line', async () => {
    // Why: the status-bar segment and the inline annotation debounce the same
    // cursor line independently. Before the in-flight key existed, the second
    // caller queued a duplicate that the pump ran as soon as the first settled.
    mocks.getRuntimeGitFileBlame.mockResolvedValue(null)
    let resolveFirst: ((value: GitLineBlameResult | null) => void) | undefined
    mocks.getRuntimeGitLineBlame.mockImplementation(
      () => new Promise((resolve) => (resolveFirst = resolve))
    )

    requestLineBlame(target(5))
    await settle()
    requestLineBlame(target(5))
    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)

    resolveFirst?.(blame('Neil'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)
  })

  it('still runs the newest line queued while another was in flight', async () => {
    mocks.getRuntimeGitFileBlame.mockResolvedValue(null)
    let resolveFirst: ((value: GitLineBlameResult | null) => void) | undefined
    mocks.getRuntimeGitLineBlame.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    )
    mocks.getRuntimeGitLineBlame.mockImplementation(async () => blame('Later'))

    requestLineBlame(target(5))
    await settle()
    requestLineBlame(target(40))
    await settle()
    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)

    resolveFirst?.(blame('Neil'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(2)
    expect(mocks.getRuntimeGitLineBlame.mock.calls[1][1]).toEqual({
      filePath: 'src/index.ts',
      line: 40
    })
  })

  it('serves an already-read line from cache instead of asking git again', async () => {
    mocks.getRuntimeGitFileBlame.mockResolvedValue(null)
    mocks.getRuntimeGitLineBlame.mockResolvedValue(blame('Neil'))

    requestLineBlame(target(5))
    await settle()
    expect(cachedLineBlame(blameKey(target(5)))?.author).toBe('Neil')

    requestLineBlame(target(5))

    expect(mocks.getRuntimeGitLineBlame).toHaveBeenCalledTimes(1)
  })
})
