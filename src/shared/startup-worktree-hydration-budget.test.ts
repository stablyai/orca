import { describe, expect, it } from 'vitest'
import {
  STARTUP_WORKTREE_HYDRATION_LIMIT,
  eagerWorkspaceSessionHydrationEntries,
  planStartupWorktreeHydration,
  startupHydrationCandidate,
  startupWorktreeHydrationOverrunMessage
} from './startup-worktree-hydration-budget'

function automation(index: number, status = 'in-progress') {
  return startupHydrationCandidate({
    worktreeId: `repo::/wt/auto-${index}`,
    isActive: false,
    automationKind: 'created-by-automation',
    workspaceStatus: status,
    lastVisitedAt: index
  })
}

describe('planStartupWorktreeHydration', () => {
  it('keeps the active workspace and live terminals, and leaves automation leftovers lazy', () => {
    const plan = planStartupWorktreeHydration([
      automation(1),
      automation(2, 'completed'),
      startupHydrationCandidate({
        worktreeId: 'repo::/wt/active',
        isActive: true,
        workspaceStatus: 'in-progress'
      }),
      startupHydrationCandidate({
        worktreeId: 'repo::/wt/live',
        isActive: false,
        tabs: [{ ptyId: 'pty-live' }],
        automationKind: 'created-by-automation',
        workspaceStatus: 'completed'
      }),
      startupHydrationCandidate({
        worktreeId: 'repo::/wt/done',
        isActive: false,
        workspaceStatus: 'completed'
      })
    ])

    expect(plan.overrunMessage).toBeNull()
    expect(plan.eagerWorktreeIds).toEqual(['repo::/wt/active', 'repo::/wt/live'])
    expect(plan.deferredWorktreeIds).toEqual([
      'repo::/wt/auto-1',
      'repo::/wt/auto-2',
      'repo::/wt/done'
    ])
  })

  it('reports worktree count and limit when historical checkouts exceed the startup graph', () => {
    const count = STARTUP_WORKTREE_HYDRATION_LIMIT + 357
    const candidates = Array.from({ length: count }, (_, index) => automation(index))
    candidates.push(
      startupHydrationCandidate({
        worktreeId: 'repo::/main',
        isActive: true,
        workspaceStatus: 'in-progress'
      })
    )
    const plan = planStartupWorktreeHydration(candidates)

    expect(plan.worktreeCount).toBe(count + 1)
    expect(plan.limit).toBe(STARTUP_WORKTREE_HYDRATION_LIMIT)
    expect(plan.overrunMessage).toBe(
      startupWorktreeHydrationOverrunMessage(count + 1, STARTUP_WORKTREE_HYDRATION_LIMIT)
    )
    expect(plan.overrunMessage).toBe(
      `worktree count = ${count + 1}, limit = ${STARTUP_WORKTREE_HYDRATION_LIMIT}`
    )
    expect(plan.eagerWorktreeIds).toEqual(['repo::/main'])
    expect(plan.deferredWorktreeIds).toHaveLength(count)
  })

  it('caps non-live in-progress worktrees and still keeps every live terminal', () => {
    const live = Array.from({ length: 3 }, (_, index) =>
      startupHydrationCandidate({
        worktreeId: `repo::/live-${index}`,
        isActive: false,
        tabs: [{ ptyId: `pty-${index}` }],
        workspaceStatus: 'in-progress'
      })
    )
    const recent = Array.from({ length: STARTUP_WORKTREE_HYDRATION_LIMIT }, (_, index) =>
      startupHydrationCandidate({
        worktreeId: `repo::/recent-${index}`,
        isActive: false,
        workspaceStatus: 'in-progress',
        lastVisitedAt: index + 1
      })
    )
    const plan = planStartupWorktreeHydration([...recent, ...live], 5)

    expect(plan.eagerWorktreeIds).toEqual([
      'repo::/live-0',
      'repo::/live-1',
      'repo::/live-2',
      'repo::/recent-127',
      'repo::/recent-126'
    ])
    expect(plan.overrunMessage).toBe('worktree count = 131, limit = 5')
  })
})

describe('eagerWorkspaceSessionHydrationEntries', () => {
  it('hydrates the active session and skips hundreds of automation tabs', () => {
    const entries: (readonly [string, readonly { ptyId: null }[]])[] = Array.from(
      { length: 485 },
      (_, index) => [`repo::/auto-${index}`, [{ ptyId: null }]] as const
    )
    entries.push(['repo::/main', [{ ptyId: null }]])
    const selected = eagerWorkspaceSessionHydrationEntries(
      { activeWorktreeId: 'repo::/main', lastVisitedAtByWorktreeId: {} },
      entries,
      (worktreeId) =>
        worktreeId === 'repo::/main'
          ? { workspaceStatus: 'in-progress' }
          : {
              automationProvenance: { kind: 'created-by-automation' },
              workspaceStatus: 'in-progress'
            }
    )

    expect(selected.worktreeCount).toBe(486)
    expect(selected.overrunMessage).toBe(
      `worktree count = 486, limit = ${STARTUP_WORKTREE_HYDRATION_LIMIT}`
    )
    expect(selected.entries.map(([worktreeId]) => worktreeId)).toEqual(['repo::/main'])
  })
})
