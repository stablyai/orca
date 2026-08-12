import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { BeadsIssue, BeadsWorkspaceStatus } from '../../../../shared/beads-types'
import { normalizeTaskSourceContext } from '../../../../shared/task-source-context'
import type { BeadsIssueFetchPlan } from '../../../../shared/beads-task-query'
import { beadsIssueListCacheKey, createBeadsSlice } from './beads'

const OPEN_PLAN: BeadsIssueFetchPlan = { statusScope: 'open', assignee: null, legacyPreset: 'open' }
const READY_PLAN: BeadsIssueFetchPlan = {
  statusScope: 'ready',
  assignee: null,
  legacyPreset: 'ready'
}

// Why: vi.mock factories run during hoisted imports, before module-body class initialization.
const { beadsListIssues, beadsUpdateIssue, MockBeadsUnsupportedError } = vi.hoisted(() => {
  class MockBeadsUnsupportedError extends Error {}
  return { beadsListIssues: vi.fn(), beadsUpdateIssue: vi.fn(), MockBeadsUnsupportedError }
})

vi.mock('@/runtime/runtime-beads-client', () => ({
  beadsListIssues: (...args: unknown[]) => beadsListIssues(...args),
  beadsUpdateIssue: (...args: unknown[]) => beadsUpdateIssue(...args),
  BeadsTaskSourceUnsupportedError: MockBeadsUnsupportedError,
  isBeadsTaskSourceUnsupportedError: (error: unknown) => error instanceof MockBeadsUnsupportedError
}))

function createTestStore() {
  return create<AppState>()((...a) => createBeadsSlice(...a) as AppState)
}

function makeIssue(id: string): BeadsIssue {
  return {
    id,
    title: `Issue ${id}`,
    status: 'open',
    priority: 2,
    issueType: 'task',
    labels: [],
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    dependencyCount: 0,
    dependentCount: 0,
    commentCount: 0
  }
}

const READY_STATUS: BeadsWorkspaceStatus = {
  bdInstalled: true,
  bdVersion: '1.1.2',
  versionSupported: true,
  initialized: true
}

function makeContext(repoId = 'repo-1') {
  const context = normalizeTaskSourceContext({
    provider: 'beads',
    projectId: 'proj-1',
    hostId: 'local',
    repoId
  })
  if (!context) {
    throw new Error('fixture context failed to normalize')
  }
  return context
}

describe('beads slice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    // Why: bumps the module-level generation so state from prior tests is stranded.
    store.getState().invalidateBeadsIssues()
    beadsListIssues.mockReset()
    beadsUpdateIssue.mockReset()
  })

  it('caches per scope+plan and dedupes reads within the TTL', async () => {
    const context = makeContext()
    const result = { issues: [makeIssue('orca-a1')], status: READY_STATUS }
    beadsListIssues.mockResolvedValue(result)

    await expect(store.getState().fetchBeadsIssues(context, OPEN_PLAN)).resolves.toEqual(result)
    expect(beadsListIssues).toHaveBeenCalledTimes(1)
    expect(beadsListIssues).toHaveBeenCalledWith(context, {
      repoId: 'repo-1',
      preset: 'open',
      limit: 200,
      statusScope: 'open'
    })

    await expect(store.getState().fetchBeadsIssues(context, OPEN_PLAN)).resolves.toEqual(result)
    expect(beadsListIssues).toHaveBeenCalledTimes(1)

    await store.getState().fetchBeadsIssues(context, READY_PLAN)
    expect(beadsListIssues).toHaveBeenCalledTimes(2)
    expect(beadsListIssues).toHaveBeenLastCalledWith(context, {
      repoId: 'repo-1',
      preset: 'ready',
      limit: 200,
      statusScope: 'ready'
    })
  })

  it('passes the plan assignee over the wire and omits it when null', async () => {
    const context = makeContext()
    beadsListIssues.mockResolvedValue({ issues: [], status: READY_STATUS })

    await store.getState().fetchBeadsIssues(context, {
      statusScope: 'all',
      assignee: '@me',
      legacyPreset: 'assigned'
    })

    expect(beadsListIssues).toHaveBeenCalledWith(context, {
      repoId: 'repo-1',
      preset: 'assigned',
      limit: 200,
      statusScope: 'all',
      assignee: '@me'
    })
  })

  it('returns stale data immediately and refreshes it in the background', async () => {
    const context = makeContext()
    const cacheKey = beadsIssueListCacheKey(context, OPEN_PLAN)
    const staleResult = { issues: [makeIssue('orca-a1')], status: READY_STATUS }
    const freshResult = { issues: [makeIssue('orca-b2')], status: READY_STATUS }
    beadsListIssues.mockResolvedValueOnce(staleResult)
    await store.getState().fetchBeadsIssues(context, OPEN_PLAN)
    store.setState((s) => ({
      beadsListCache: {
        ...s.beadsListCache,
        [cacheKey]: { ...s.beadsListCache[cacheKey], fetchedAt: Date.now() - 61_000 }
      }
    }))

    beadsListIssues.mockResolvedValueOnce(freshResult)
    await expect(store.getState().fetchBeadsIssues(context, OPEN_PLAN)).resolves.toEqual(
      staleResult
    )
    expect(beadsListIssues).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => {
      expect(store.getState().beadsListCache[cacheKey]?.data).toEqual(freshResult)
    })
  })

  it('records a missing-capability error and rethrows it to the foreground caller', async () => {
    const context = makeContext()
    beadsListIssues.mockRejectedValue(new MockBeadsUnsupportedError('old host'))

    await expect(store.getState().fetchBeadsIssues(context, OPEN_PLAN)).rejects.toBeInstanceOf(
      MockBeadsUnsupportedError
    )
    const entry = store.getState().beadsListCache[beadsIssueListCacheKey(context, OPEN_PLAN)]
    expect(entry?.error).toBe('missing-task-source-capability')
    expect(entry?.data).toBeNull()
  })

  it('keeps the last good list when a background refresh fails', async () => {
    const context = makeContext()
    const cacheKey = beadsIssueListCacheKey(context, OPEN_PLAN)
    const goodResult = { issues: [makeIssue('orca-a1')], status: READY_STATUS }
    beadsListIssues.mockResolvedValueOnce(goodResult)
    await store.getState().fetchBeadsIssues(context, OPEN_PLAN)
    store.setState((s) => ({
      beadsListCache: {
        ...s.beadsListCache,
        [cacheKey]: { ...s.beadsListCache[cacheKey], fetchedAt: Date.now() - 61_000 }
      }
    }))

    beadsListIssues.mockRejectedValueOnce(new Error('bd exploded'))
    await expect(store.getState().fetchBeadsIssues(context, OPEN_PLAN)).resolves.toEqual(goodResult)
    await vi.waitFor(() => {
      expect(store.getState().beadsListCache[cacheKey]?.error).toBe('load-failed')
    })
    expect(store.getState().beadsListCache[cacheKey]?.data).toEqual(goodResult)
  })

  it('invalidation strands in-flight reads so late results cannot repopulate the cache', async () => {
    const context = makeContext()
    let resolveRead!: (value: unknown) => void
    beadsListIssues.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve
      })
    )
    const pending = store.getState().fetchBeadsIssues(context, OPEN_PLAN)
    store.getState().invalidateBeadsIssues()
    resolveRead({ issues: [makeIssue('orca-late')], status: READY_STATUS })
    await pending
    expect(store.getState().beadsListCache).toEqual({})
  })

  it('rejects a context without a repoId', async () => {
    const context = { ...makeContext(), repoId: null }
    await expect(store.getState().fetchBeadsIssues(context, OPEN_PLAN)).rejects.toThrow(/repoId/)
    expect(beadsListIssues).not.toHaveBeenCalled()
  })

  describe('updateBeadsIssueStatus', () => {
    async function seedOpenList(issues: BeadsIssue[]) {
      const context = makeContext()
      beadsListIssues.mockResolvedValueOnce({ issues, status: READY_STATUS })
      await store.getState().fetchBeadsIssues(context, OPEN_PLAN)
      return { context, cacheKey: beadsIssueListCacheKey(context, OPEN_PLAN) }
    }

    it('calls through with repoId, id, and status, and resolves with the refreshed issue', async () => {
      const { context } = await seedOpenList([makeIssue('orca-a1')])
      const refreshed = { ...makeIssue('orca-a1'), status: 'in_progress' as const, commentCount: 3 }
      beadsUpdateIssue.mockResolvedValue({ issue: refreshed, status: READY_STATUS })

      await expect(
        store.getState().updateBeadsIssueStatus(context, 'orca-a1', 'in_progress')
      ).resolves.toEqual(refreshed)
      expect(beadsUpdateIssue).toHaveBeenCalledWith(context, {
        repoId: 'repo-1',
        id: 'orca-a1',
        status: 'in_progress'
      })
    })

    it('patches the cached issue optimistically before the call resolves', async () => {
      const { context, cacheKey } = await seedOpenList([makeIssue('orca-a1'), makeIssue('orca-b2')])
      let resolveUpdate!: (value: unknown) => void
      beadsUpdateIssue.mockReturnValue(
        new Promise((resolve) => {
          resolveUpdate = resolve
        })
      )

      const pending = store.getState().updateBeadsIssueStatus(context, 'orca-a1', 'blocked')
      const optimistic = store.getState().beadsListCache[cacheKey]?.data?.issues
      expect(optimistic?.find((issue) => issue.id === 'orca-a1')?.status).toBe('blocked')
      expect(optimistic?.find((issue) => issue.id === 'orca-b2')?.status).toBe('open')

      resolveUpdate({
        issue: { ...makeIssue('orca-a1'), status: 'blocked' },
        status: READY_STATUS
      })
      await pending
    })

    it('reconciles with the returned issue and marks the scope for refetch', async () => {
      const { context, cacheKey } = await seedOpenList([makeIssue('orca-a1')])
      const refreshed = {
        ...makeIssue('orca-a1'),
        status: 'closed' as const,
        updatedAt: '2026-08-12T00:00:00Z'
      }
      beadsUpdateIssue.mockResolvedValue({ issue: refreshed, status: READY_STATUS })

      await store.getState().updateBeadsIssueStatus(context, 'orca-a1', 'closed')
      expect(store.getState().beadsListCache[cacheKey]?.data?.issues).toEqual([refreshed])

      // The reconciled entry is stale, so the next fetch refetches (SWR).
      beadsListIssues.mockResolvedValueOnce({ issues: [], status: READY_STATUS })
      await store.getState().fetchBeadsIssues(context, OPEN_PLAN)
      expect(beadsListIssues).toHaveBeenCalledTimes(2)
    })

    it('rolls back the optimistic patch and rethrows when the mutation fails', async () => {
      const { context, cacheKey } = await seedOpenList([makeIssue('orca-a1')])
      beadsUpdateIssue.mockRejectedValue(new Error('bd exploded'))

      await expect(
        store.getState().updateBeadsIssueStatus(context, 'orca-a1', 'closed')
      ).rejects.toThrow('bd exploded')
      expect(
        store.getState().beadsListCache[cacheKey]?.data?.issues.find((i) => i.id === 'orca-a1')
          ?.status
      ).toBe('open')
    })

    it('treats a null refreshed issue (bd unavailable) as a failure and rolls back', async () => {
      const { context, cacheKey } = await seedOpenList([makeIssue('orca-a1')])
      beadsUpdateIssue.mockResolvedValue({
        issue: null,
        status: { ...READY_STATUS, initialized: false }
      })

      await expect(
        store.getState().updateBeadsIssueStatus(context, 'orca-a1', 'closed')
      ).rejects.toThrow(/unavailable|not initialized/)
      expect(
        store.getState().beadsListCache[cacheKey]?.data?.issues.find((i) => i.id === 'orca-a1')
          ?.status
      ).toBe('open')
    })

    it('rejects a context without a repoId before calling through', async () => {
      const context = { ...makeContext(), repoId: null }
      await expect(
        store.getState().updateBeadsIssueStatus(context, 'orca-a1', 'closed')
      ).rejects.toThrow(/repoId/)
      expect(beadsUpdateIssue).not.toHaveBeenCalled()
    })
  })
})
