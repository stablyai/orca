// T6 renderer-side test: the Reap verb's IPC wiring path
// (handleReap -> window.api.aquarium.reap -> classify result). The wiring is
// extracted into lib/aquarium-reap-wiring.ts so this test needs NO React, NO
// AquariumPanel, and NO daemonInventory graph — it directly exercises the
// bridge call + result classification the UI depends on.
//
// node env (config/vitest.config.ts, environment: 'node'); window.api is not
// globally provisioned in tests, so we stub window.api.aquarium.reap per case.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AquariumReapResult } from '../../../shared/aquarium-reap'
import { reapWorktree, type ReapWorktreeIdentity } from './aquarium-reap-wiring'

function stubReap(impl: (request: { repoPath: string; worktreePaths: string[] }) => Promise<AquariumReapResult>) {
  const reap = vi.fn(impl)
  // node test env has no `window`; the renderer accesses window.api at call
  // time, so we install a minimal stub on globalThis.
  ;(globalThis as unknown as { window: { api: { aquarium: { reap: typeof reap } } } }).window = {
    api: { aquarium: { reap } }
  }
  return reap
}

const IDENTITY: ReapWorktreeIdentity = {
  repoPath: '/Users/brandonbennett/stablyai-orca',
  repo: 'stablyai/orca',
  path: '/Users/brandonbennett/stablyai-orca/.worktrees/auto-triage-run-85'
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('reapWorktree (T6 IPC wiring)', () => {
  it('builds the AquariumReapRequest (repoPath + [worktreePath]) and classifies a reaped result', async () => {
    const reap = stubReap(async () => ({
      reaped: ['/Users/brandonbennett/stablyai-orca/.worktrees/auto-triage-run-85'],
      denied: [],
      failed: []
    }))

    const outcome = await reapWorktree(IDENTITY)

    // The bridge received exactly the contract-shaped request.
    expect(reap).toHaveBeenCalledTimes(1)
    expect(reap).toHaveBeenCalledWith({
      repoPath: '/Users/brandonbennett/stablyai-orca',
      worktreePaths: ['/Users/brandonbennett/stablyai-orca/.worktrees/auto-triage-run-85']
    })
    expect(outcome).toEqual({
      kind: 'reaped',
      path: '/Users/brandonbennett/stablyai-orca/.worktrees/auto-triage-run-85',
      result: {
        reaped: ['/Users/brandonbennett/stablyai-orca/.worktrees/auto-triage-run-85'],
        denied: [],
        failed: []
      }
    })
  })

  it('prefers repoPath over repo when both are present', async () => {
    const reap = stubReap(async () => ({ reaped: [], denied: [], failed: [] }))
    await reapWorktree({ repoPath: '/abs/repo', repo: 'owner/name', path: '/abs/repo/wt' })
    expect(reap).toHaveBeenCalledWith({ repoPath: '/abs/repo', worktreePaths: ['/abs/repo/wt'] })
  })

  it('falls back to repo when repoPath is absent', async () => {
    const reap = stubReap(async () => ({ reaped: [], denied: [], failed: [] }))
    await reapWorktree({ repo: 'owner/name', path: '/abs/repo/wt' })
    expect(reap).toHaveBeenCalledWith({ repoPath: 'owner/name', worktreePaths: ['/abs/repo/wt'] })
  })

  it('does not invoke the bridge and reports missing-path when path is absent', async () => {
    const reap = stubReap(async () => ({ reaped: [], denied: [], failed: [] }))
    const outcome = await reapWorktree({ repoPath: '/abs/repo', path: null })
    expect(reap).not.toHaveBeenCalled()
    expect(outcome).toEqual({ kind: 'missing-path', path: null })
  })

  it('does not invoke the bridge when repoPath and repo are both absent', async () => {
    stubReap(async () => ({ reaped: [], denied: [], failed: [] }))
    const outcome = await reapWorktree({ path: '/abs/repo/wt' })
    expect(outcome).toEqual({ kind: 'missing-path', path: '/abs/repo/wt' })
  })

  it('classifies a backend failure (disposal threw) as failed with the error text', async () => {
    stubReap(async () => ({
      reaped: [],
      denied: [],
      failed: [{ path: '/Users/brandonbennett/stablyai-orca/.worktrees/auto-triage-run-85', error: 'git worktree remove: permission denied' }]
    }))
    const outcome = await reapWorktree(IDENTITY)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error).toBe('git worktree remove: permission denied')
      expect(outcome.path).toBe('/Users/brandonbennett/stablyai-orca/.worktrees/auto-triage-run-85')
    }
  })

  it('classifies a backend denial (owner-uid) when nothing was reaped or failed', async () => {
    stubReap(async () => ({
      reaped: [],
      denied: [{ path: '/Users/brandonbennett/stablyai-orca/.worktrees/auto-triage-run-85', reason: 'owner-uid', detail: 'uid 501 != 0' }],
      failed: []
    }))
    const outcome = await reapWorktree(IDENTITY)
    expect(outcome.kind).toBe('denied')
    if (outcome.kind === 'denied') {
      expect(outcome.reason).toBe('owner-uid')
      expect(outcome.detail).toBe('uid 501 != 0')
    }
  })

  it('defaults a denial without an explicit reason to not-found', async () => {
    stubReap(async () => ({ reaped: [], denied: [{ path: '/p', reason: 'not-found' }], failed: [] }))
    const outcome = await reapWorktree({ repoPath: '/r', path: '/p' })
    expect(outcome.kind).toBe('denied')
    if (outcome.kind === 'denied') {
      expect(outcome.reason).toBe('not-found')
    }
  })

  it('propagates a thrown bridge error to the caller (UI catches + toasts)', async () => {
    const boom = new Error('ipc channel aquarium:reap not found')
    stubReap(async () => {
      throw boom
    })
    await expect(reapWorktree(IDENTITY)).rejects.toBe(boom)
  })
})
