import { describe, expect, it, vi } from 'vitest'
import type { PtyCleanupInspection } from '../../../../shared/pty-inactive-cleanup'
import type { ResourceSessionBindingInputs } from './resource-session-bindings'
import type { DaemonSession } from './resource-usage-merge-types'
import {
  executeResourceSessionCleanup,
  RESOURCE_SESSION_CLEANUP_EXECUTION_ERROR,
  RESOURCE_SESSION_CLEANUP_REVIEW_ERROR,
  RESOURCE_SESSION_CLEANUP_SESSION_NOT_READY_ERROR,
  reviewResourceSessionCleanup,
  type ResourceSessionCleanupReview
} from './resource-session-cleanup-review'

function session(id: string): DaemonSession {
  return { id, cwd: '/tmp', title: id, agentOwnership: 'absent' }
}

function bindingsWith(...boundIds: string[]): ResourceSessionBindingInputs {
  return {
    tabsByWorktree: {},
    ptyIdsByTabId: { tab: boundIds },
    terminalLayoutsByTabId: {},
    workspaceSessionReady: true
  }
}

function reviewWithInactive(...ids: string[]): ResourceSessionCleanupReview {
  return {
    reviewedIds: ids,
    inspections: ids.map((id) => ({ id, safety: 'inactive' })),
    inactiveIds: ids,
    activeCount: 0,
    unknownCount: 0,
    goneCount: 0
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('resource session cleanup review', () => {
  it('reviews only ids still unbound after the fresh list resolves', async () => {
    const list = deferred<DaemonSession[]>()
    const readBindings = vi.fn(() => bindingsWith('became-bound'))
    const inspect = vi
      .fn<(ids: string[]) => Promise<PtyCleanupInspection[]>>()
      .mockResolvedValue([{ id: 'still-unbound', safety: 'inactive' }])
    const reviewPromise = reviewResourceSessionCleanup({
      listSessions: () => list.promise,
      readBindings,
      inspectInactiveCleanup: inspect
    })

    list.resolve([session('became-bound'), session('still-unbound')])

    await expect(reviewPromise).resolves.toMatchObject({ inactiveIds: ['still-unbound'] })
    expect(inspect).toHaveBeenCalledWith(['still-unbound'])
  })

  it('protects sessions whose agent ownership is present or unknown before inspection', async () => {
    const inspect = vi
      .fn<(ids: string[]) => Promise<PtyCleanupInspection[]>>()
      .mockResolvedValue([{ id: 'known-empty', safety: 'inactive' }])

    await expect(
      reviewResourceSessionCleanup({
        listSessions: async () => [
          session('known-empty'),
          { ...session('agent-owned'), agentOwnership: 'present' },
          { ...session('legacy-provider'), agentOwnership: 'unknown' }
        ],
        readBindings: () => bindingsWith(),
        inspectInactiveCleanup: inspect
      })
    ).resolves.toMatchObject({
      reviewedIds: ['known-empty'],
      inactiveIds: ['known-empty']
    })
    expect(inspect).toHaveBeenCalledWith(['known-empty'])
  })

  it('summarizes active, unknown, and gone inspections without enabling them', async () => {
    const review = await reviewResourceSessionCleanup({
      listSessions: async () => [session('active'), session('unknown'), session('gone')],
      readBindings: () => bindingsWith(),
      inspectInactiveCleanup: async () => [
        { id: 'active', safety: 'active' },
        { id: 'unknown', safety: 'unknown' },
        { id: 'gone', safety: 'gone' }
      ]
    })

    expect(review).toMatchObject({
      inactiveIds: [],
      activeCount: 1,
      unknownCount: 1,
      goneCount: 1
    })
  })

  it('skips inactive-cleanup inspection when every current session is bound', async () => {
    const inspect = vi.fn()

    await expect(
      reviewResourceSessionCleanup({
        listSessions: async () => [session('bound')],
        readBindings: () => bindingsWith('bound'),
        inspectInactiveCleanup: inspect
      })
    ).resolves.toEqual({
      reviewedIds: [],
      inspections: [],
      inactiveIds: [],
      activeCount: 0,
      unknownCount: 0,
      goneCount: 0
    })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('blocks review until workspace session hydration is ready', async () => {
    await expect(
      reviewResourceSessionCleanup({
        listSessions: async () => [session('idle')],
        readBindings: () => ({ ...bindingsWith(), workspaceSessionReady: false }),
        inspectInactiveCleanup: vi.fn()
      })
    ).rejects.toThrow(RESOURCE_SESSION_CLEANUP_SESSION_NOT_READY_ERROR)
  })

  it('replaces IPC failures with stable review copy', async () => {
    await expect(
      reviewResourceSessionCleanup({
        listSessions: async () => {
          throw new Error('raw transport details')
        },
        readBindings: () => bindingsWith(),
        inspectInactiveCleanup: vi.fn()
      })
    ).rejects.toThrow(RESOURCE_SESSION_CLEANUP_REVIEW_ERROR)
  })

  it('re-intersects reviewed ids before guarded cleanup and never chases new sessions', async () => {
    const kill = vi.fn().mockResolvedValue([{ id: 'reviewed', outcome: 'killed' }])

    await executeResourceSessionCleanup(reviewWithInactive('reviewed'), {
      listSessions: async () => [session('reviewed'), session('new-session')],
      readBindings: () => bindingsWith('new-session'),
      killInactiveSessions: kill
    })

    expect(kill).toHaveBeenCalledWith(['reviewed'])
  })

  it('blocks cleanup until workspace session hydration is ready', async () => {
    await expect(
      executeResourceSessionCleanup(reviewWithInactive('idle'), {
        listSessions: async () => [session('idle')],
        readBindings: () => ({ ...bindingsWith(), workspaceSessionReady: false }),
        killInactiveSessions: vi.fn()
      })
    ).rejects.toThrow(RESOURCE_SESSION_CLEANUP_SESSION_NOT_READY_ERROR)
  })

  it('replaces cleanup transport failures with stable execution copy', async () => {
    await expect(
      executeResourceSessionCleanup(reviewWithInactive('idle'), {
        listSessions: async () => [session('idle')],
        readBindings: () => bindingsWith(),
        killInactiveSessions: async () => {
          throw new Error('raw transport details')
        }
      })
    ).rejects.toThrow(RESOURCE_SESSION_CLEANUP_EXECUTION_ERROR)
  })

  it('protects a reviewed candidate that becomes bound and counts a disappeared one as gone', async () => {
    const kill = vi.fn().mockResolvedValue([])

    const result = await executeResourceSessionCleanup(reviewWithInactive('bound', 'gone'), {
      listSessions: async () => [session('bound')],
      readBindings: () => bindingsWith('bound'),
      killInactiveSessions: kill
    })

    expect(kill).not.toHaveBeenCalled()
    expect(result).toEqual({ killedCount: 0, protectedCount: 1, goneCount: 1, failedCount: 0 })
  })

  it('protects a reviewed candidate that gains agent ownership before cleanup', async () => {
    const kill = vi.fn()

    const result = await executeResourceSessionCleanup(reviewWithInactive('claimed'), {
      listSessions: async () => [{ ...session('claimed'), agentOwnership: 'present' }],
      readBindings: () => bindingsWith(),
      killInactiveSessions: kill
    })

    expect(kill).not.toHaveBeenCalled()
    expect(result).toEqual({ killedCount: 0, protectedCount: 1, goneCount: 0, failedCount: 0 })
  })

  it('includes initial review results alongside inactive-candidate revalidation', async () => {
    const reviewedIds = [
      'initial-active',
      'initial-unknown',
      'initial-gone',
      'still-inactive',
      'became-bound',
      'became-gone'
    ]
    const review = await reviewResourceSessionCleanup({
      listSessions: async () => reviewedIds.map(session),
      readBindings: () => bindingsWith(),
      inspectInactiveCleanup: async () => [
        { id: 'initial-active', safety: 'active' },
        { id: 'initial-unknown', safety: 'unknown' },
        { id: 'initial-gone', safety: 'gone' },
        { id: 'still-inactive', safety: 'inactive' },
        { id: 'became-bound', safety: 'inactive' },
        { id: 'became-gone', safety: 'inactive' }
      ]
    })
    const kill = vi.fn().mockResolvedValue([{ id: 'still-inactive', outcome: 'killed' }])

    const result = await executeResourceSessionCleanup(review, {
      listSessions: async () =>
        ['initial-active', 'initial-unknown', 'still-inactive', 'became-bound'].map(session),
      readBindings: () => bindingsWith('became-bound'),
      killInactiveSessions: kill
    })

    expect(kill).toHaveBeenCalledWith(['still-inactive'])
    expect(result).toEqual({ killedCount: 1, protectedCount: 3, goneCount: 2, failedCount: 0 })
  })

  it('summarizes guarded cleanup outcomes without aborting partial results', async () => {
    const result = await executeResourceSessionCleanup(
      reviewWithInactive('killed', 'active', 'unknown', 'gone', 'failed'),
      {
        listSessions: async () => ['killed', 'active', 'unknown', 'gone', 'failed'].map(session),
        readBindings: () => bindingsWith(),
        killInactiveSessions: async () => [
          { id: 'killed', outcome: 'killed' },
          { id: 'active', outcome: 'protected-active' },
          { id: 'unknown', outcome: 'protected-unknown' },
          { id: 'gone', outcome: 'gone' },
          { id: 'failed', outcome: 'failed' }
        ]
      }
    )

    expect(result).toEqual({ killedCount: 1, protectedCount: 2, goneCount: 1, failedCount: 1 })
  })
})
