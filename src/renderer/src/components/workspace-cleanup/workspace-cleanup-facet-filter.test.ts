import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceCleanupFacetList,
  countWorkspaceCleanupMeasuredRows
} from './workspace-cleanup-facets'
import {
  buildWorkspaceCleanupSizeIndex,
  buildWorkspaceCleanupWorktreeIndex,
  getWorkspaceCleanupHostIdentity
} from './workspace-cleanup-host-identity'
import {
  DAY,
  FACET_NOW,
  makeFacetCandidate,
  makeFacets,
  makeNamedFacets
} from './workspace-cleanup-facet.test.fixture'
import {
  createDefaultWorkspaceCleanupFilterState,
  type WorkspaceCleanupFilterState
} from '../../../../shared/workspace-cleanup-filter-model'
import {
  countWorkspaceCleanupFacetMatches,
  filterWorkspaceCleanupFacets,
  matchesWorkspaceCleanupFilters,
  queryWorkspaceCleanupCandidates
} from './workspace-cleanup-query'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { canQueueWorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'

function filters(patch: (state: WorkspaceCleanupFilterState) => void): WorkspaceCleanupFilterState {
  const state = createDefaultWorkspaceCleanupFilterState()
  patch(state)
  return state
}

const ANY = filters((state) => {
  state.safety.dismissed = 'any'
})

describe('facet building', () => {
  it('strips the ref prefix and falls back to local host', () => {
    const facets = makeFacets({ worktree: { branch: 'refs/heads/feature/x' } })
    expect(facets.branch).toBe('feature/x')
    expect(facets.hostId).toBe('local')
  })

  it('preserves a disconnected candidate execution host', () => {
    const facets = makeFacets({
      candidate: { connectionId: 'builder', executionHostId: 'ssh:builder' },
      worktree: null
    })
    expect(facets.hostId).toBe('ssh:builder')
  })

  it('treats a missing size entry as unsized rather than zero', () => {
    expect(makeFacets().sizeBytes).toBeNull()
    expect(makeFacets({ sizeBytes: 0 }).sizeBytes).toBe(0)
  })

  it('treats a missing visit stamp as never opened', () => {
    expect(makeFacets().lastVisitedAt).toBeNull()
    expect(makeFacets({ lastVisitedAt: FACET_NOW }).lastVisitedAt).toBe(FACET_NOW)
  })

  it('resolves the visible workspace status without changing statusless filter semantics', () => {
    expect(makeFacets().workspaceStatus).toBeNull()
    expect(makeFacets().workspaceStatusLabel).toBe('In progress')
    expect(makeFacets({ worktree: { workspaceStatus: 'in-review' } }).workspaceStatusLabel).toBe(
      'In review'
    )
    expect(makeFacets({ worktree: null }).workspaceStatusLabel).toBeNull()
  })

  it('only trusts sizes from an ok space scan', () => {
    const scanned = [
      { worktreeId: 'a', status: 'ok', sizeBytes: 10 },
      { worktreeId: 'b', status: 'permission-denied', sizeBytes: 99 }
    ] as WorkspaceSpaceWorktree[]
    const index = buildWorkspaceCleanupSizeIndex(scanned)
    expect(index.get('a')).toBe(10)
    expect(index.has('b')).toBe(false)
  })

  it('counts measurements only for rows in the current fleet', () => {
    const rows = [makeFacets({ sizeBytes: 10 }), makeNamedFacets('unsized')]
    expect(countWorkspaceCleanupMeasuredRows(rows)).toBe(1)
  })

  it('indexes worktrees across repos by host and id', () => {
    const index = buildWorkspaceCleanupWorktreeIndex({
      'repo-1': [{ id: 'w1', hostId: 'local' }],
      'repo-2': [{ id: 'w2', hostId: 'ssh:builder' }]
    })
    expect([...index.keys()]).toEqual([
      getWorkspaceCleanupHostIdentity('local', 'w1'),
      getWorkspaceCleanupHostIdentity('ssh:builder', 'w2')
    ])
  })

  it('keeps same-id worktrees and sizes isolated by host', () => {
    const candidates = [
      makeFacetCandidate({ executionHostId: 'local' }),
      makeFacetCandidate({
        executionHostId: 'ssh:builder',
        connectionId: 'builder'
      })
    ]
    const sizes = buildWorkspaceCleanupSizeIndex(
      [
        {
          worktreeId: candidates[0]!.worktreeId,
          executionHostId: 'local',
          status: 'ok',
          sizeBytes: 10
        },
        {
          worktreeId: candidates[1]!.worktreeId,
          executionHostId: 'ssh:builder',
          status: 'ok',
          sizeBytes: 20
        }
      ],
      candidates
    )

    expect(sizes.get(getWorkspaceCleanupHostIdentity('local', candidates[0]!.worktreeId))).toBe(10)
    expect(
      sizes.get(getWorkspaceCleanupHostIdentity('ssh:builder', candidates[1]!.worktreeId))
    ).toBe(20)
    expect(sizes.has(candidates[0]!.worktreeId)).toBe(false)
  })

  it('does not apply a legacy size to duplicate candidate ids', () => {
    const candidates = [
      makeFacetCandidate({ executionHostId: 'local' }),
      makeFacetCandidate({
        executionHostId: 'ssh:builder',
        connectionId: 'builder'
      })
    ]
    const sizes = buildWorkspaceCleanupSizeIndex(
      [{ worktreeId: candidates[0]!.worktreeId, status: 'ok', sizeBytes: 10 }],
      candidates
    )

    expect(sizes.size).toBe(0)
  })

  it('does not apply duplicate legacy size rows to one current candidate', () => {
    const candidate = makeFacetCandidate({ executionHostId: 'local' })
    const sizes = buildWorkspaceCleanupSizeIndex(
      [
        { worktreeId: candidate.worktreeId, status: 'ok', sizeBytes: 10 },
        { worktreeId: candidate.worktreeId, status: 'ok', sizeBytes: 20 }
      ],
      [candidate]
    )

    expect(sizes.size).toBe(0)
  })

  it('does not assign legacy worktree metadata with multi-host repo ownership', () => {
    const index = buildWorkspaceCleanupWorktreeIndex(
      { 'repo-1': [{ id: 'w1', repoId: 'repo-1' }] },
      [
        { id: 'repo-1', executionHostId: 'local' },
        { id: 'repo-1', executionHostId: 'ssh:builder' }
      ]
    )

    expect(index.size).toBe(0)
  })

  it('counts a workspace with nothing attached as completely empty', () => {
    expect(makeFacets().isCompletelyEmpty).toBe(true)
    expect(makeFacets({ worktree: { comment: 'keep' } }).isCompletelyEmpty).toBe(false)
    expect(makeFacets({ review: {} }).isCompletelyEmpty).toBe(false)
    expect(makeFacets({ worktree: { linkedIssue: 12 } }).isCompletelyEmpty).toBe(false)
  })
})

describe('query search', () => {
  it('matches branch, host, status, provider, and blockers', () => {
    const facets = makeFacets({
      candidate: { blockers: ['live-agent'] },
      worktree: {
        branch: 'refs/heads/fix/login',
        hostId: 'ssh:builder',
        workspaceStatus: 'in-review'
      },
      review: { provider: 'gitlab', label: 'MR #7' }
    })
    for (const term of ['fix/login', 'ssh:builder', 'in-review', 'gitlab', 'live-agent']) {
      expect(matchesWorkspaceCleanupFilters(facets, { ...ANY, query: term }, FACET_NOW)).toBe(true)
    }
    expect(matchesWorkspaceCleanupFilters(facets, { ...ANY, query: 'nope' }, FACET_NOW)).toBe(false)
  })
})

describe('activity filter', () => {
  it('uses the user-chosen day threshold against the chosen signal', () => {
    const recentlyVisited = makeFacets({ lastVisitedAt: FACET_NOW - 5 * DAY })
    const staleVisit = makeFacets({ lastVisitedAt: FACET_NOW - 45 * DAY })
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.activity.idleSignal = 'last-visited'
      s.activity.idleMinDays = 30
    })
    expect(matchesWorkspaceCleanupFilters(recentlyVisited, state, FACET_NOW)).toBe(false)
    expect(matchesWorkspaceCleanupFilters(staleVisit, state, FACET_NOW)).toBe(true)
  })

  it('reads a missing signal as maximally idle', () => {
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.activity.idleMinDays = 365
    })
    expect(matchesWorkspaceCleanupFilters(makeFacets(), state, FACET_NOW)).toBe(true)
  })

  it('separates background activity from a real visit', () => {
    const busyButUnopened = makeFacets({
      candidate: { lastActivityAt: FACET_NOW }
    })
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.activity.neverVisited = true
    })
    expect(matchesWorkspaceCleanupFilters(busyButUnopened, state, FACET_NOW)).toBe(true)
    expect(
      matchesWorkspaceCleanupFilters(makeFacets({ lastVisitedAt: FACET_NOW }), state, FACET_NOW)
    ).toBe(false)
  })
})

describe('size filter', () => {
  it('keeps unsized rows unless the user opts out', () => {
    const unsized = makeFacets()
    expect(matchesWorkspaceCleanupFilters(unsized, ANY, FACET_NOW)).toBe(true)
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.size.includeUnsized = false
    })
    expect(matchesWorkspaceCleanupFilters(unsized, state, FACET_NOW)).toBe(false)
  })

  it('applies min and max byte bounds', () => {
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.size.minBytes = 100
      s.size.maxBytes = 200
    })
    expect(matchesWorkspaceCleanupFilters(makeFacets({ sizeBytes: 150 }), state, FACET_NOW)).toBe(
      true
    )
    expect(matchesWorkspaceCleanupFilters(makeFacets({ sizeBytes: 99 }), state, FACET_NOW)).toBe(
      false
    )
    expect(matchesWorkspaceCleanupFilters(makeFacets({ sizeBytes: 201 }), state, FACET_NOW)).toBe(
      false
    )
  })
})

describe('status filter', () => {
  it('matches open workspace-status strings and statusless rows separately', () => {
    const inReview = makeFacets({ worktree: { workspaceStatus: 'in-review' } })
    const statusless = makeFacets()
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.status.workspaceStatuses = ['in-review']
      s.status.matchStatusless = false
    })
    expect(matchesWorkspaceCleanupFilters(inReview, state, FACET_NOW)).toBe(true)
    expect(matchesWorkspaceCleanupFilters(statusless, state, FACET_NOW)).toBe(false)
    state.status.matchStatusless = true
    expect(matchesWorkspaceCleanupFilters(statusless, state, FACET_NOW)).toBe(true)
  })

  it('excludes statusless rows even when no named status is selected', () => {
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.status.workspaceStatuses = []
      s.status.matchStatusless = false
    })
    expect(matchesWorkspaceCleanupFilters(makeFacets(), state, FACET_NOW)).toBe(false)
    expect(
      matchesWorkspaceCleanupFilters(
        makeFacets({ worktree: { workspaceStatus: 'in-review' } }),
        state,
        FACET_NOW
      )
    ).toBe(true)
  })

  it('applies tri-state flags', () => {
    const archived = makeFacets({ worktree: { isArchived: true } })
    const only = filters((s) => {
      s.safety.dismissed = 'any'
      s.status.archived = 'only'
    })
    const exclude = filters((s) => {
      s.safety.dismissed = 'any'
      s.status.archived = 'exclude'
    })
    expect(matchesWorkspaceCleanupFilters(archived, only, FACET_NOW)).toBe(true)
    expect(matchesWorkspaceCleanupFilters(archived, exclude, FACET_NOW)).toBe(false)
    expect(matchesWorkspaceCleanupFilters(makeFacets(), exclude, FACET_NOW)).toBe(true)
  })
})

describe('agent, git, review, ticket, context, and location filters', () => {
  it('filters by live agent rollup and retained done agents', () => {
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.agent.states = ['permission']
    })
    expect(
      matchesWorkspaceCleanupFilters(makeFacets({ agentStatus: 'permission' }), state, FACET_NOW)
    ).toBe(true)
    expect(
      matchesWorkspaceCleanupFilters(makeFacets({ agentStatus: 'working' }), state, FACET_NOW)
    ).toBe(false)
    expect(makeFacets().agentState).toBe('idle')

    const retained = filters((s) => {
      s.safety.dismissed = 'any'
      s.agent.retainedDoneAgents = 'only'
    })
    const withRetained = makeFacets({
      candidate: {
        localContext: {
          ...makeFacetCandidate().localContext,
          retainedDoneAgentCount: 2
        }
      }
    })
    expect(matchesWorkspaceCleanupFilters(withRetained, retained, FACET_NOW)).toBe(true)
    expect(matchesWorkspaceCleanupFilters(makeFacets(), retained, FACET_NOW)).toBe(false)
  })

  it('filters by git state, ahead counts, branch text, prunable and locked', () => {
    const unpushed = makeFacets({
      candidate: {
        git: { clean: true, upstreamAhead: 3, upstreamBehind: 1, checkedAt: 1 }
      }
    })
    expect(unpushed.gitState).toBe('unpushed')
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.git.states = ['unpushed']
      s.git.minAhead = 2
    })
    expect(matchesWorkspaceCleanupFilters(unpushed, state, FACET_NOW)).toBe(true)
    state.git.minAhead = 4
    expect(matchesWorkspaceCleanupFilters(unpushed, state, FACET_NOW)).toBe(false)

    const branchState = filters((s) => {
      s.safety.dismissed = 'any'
      s.git.branchQuery = 'ALPH'
    })
    expect(matchesWorkspaceCleanupFilters(makeFacets(), branchState, FACET_NOW)).toBe(true)

    const prunable = filters((s) => {
      s.safety.dismissed = 'any'
      s.git.prunable = 'only'
    })
    expect(
      matchesWorkspaceCleanupFilters(
        makeFacets({ worktree: { prunable: true } }),
        prunable,
        FACET_NOW
      )
    ).toBe(true)
    expect(matchesWorkspaceCleanupFilters(makeFacets(), prunable, FACET_NOW)).toBe(false)
  })

  it('keeps review filtering provider-general and treats draft as a state', () => {
    const draftMr = makeFacets({
      review: { provider: 'gitlab', state: 'draft', label: 'MR #7' }
    })
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.review.presence = 'some'
      s.review.states = ['draft']
      s.review.providers = ['gitlab', 'bitbucket']
    })
    expect(matchesWorkspaceCleanupFilters(draftMr, state, FACET_NOW)).toBe(true)
    state.review.providers = ['github']
    expect(matchesWorkspaceCleanupFilters(draftMr, state, FACET_NOW)).toBe(false)

    const none = filters((s) => {
      s.safety.dismissed = 'any'
      s.review.presence = 'none'
    })
    expect(matchesWorkspaceCleanupFilters(makeFacets(), none, FACET_NOW)).toBe(true)
    expect(matchesWorkspaceCleanupFilters(draftMr, none, FACET_NOW)).toBe(false)
  })

  it('filters by ticket source', () => {
    const linear = makeFacets({ worktree: { linkedLinearIssue: 'STA-1' } })
    expect(linear.ticketSources).toEqual(['linear'])
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.ticket.presence = 'some'
      s.ticket.sources = ['linear']
    })
    expect(matchesWorkspaceCleanupFilters(linear, state, FACET_NOW)).toBe(true)
    expect(
      matchesWorkspaceCleanupFilters(makeFacets({ worktree: { linkedIssue: 9 } }), state, FACET_NOW)
    ).toBe(false)
  })

  it('filters by local context and completely-empty', () => {
    const busy = makeFacets({
      candidate: {
        localContext: {
          ...makeFacetCandidate().localContext,
          terminalTabCount: 2
        }
      }
    })
    const hasContext = filters((s) => {
      s.safety.dismissed = 'any'
      s.context.presence = 'some'
    })
    expect(matchesWorkspaceCleanupFilters(busy, hasContext, FACET_NOW)).toBe(true)
    const empty = filters((s) => {
      s.safety.dismissed = 'any'
      s.context.completelyEmpty = true
    })
    expect(matchesWorkspaceCleanupFilters(busy, empty, FACET_NOW)).toBe(false)
    expect(matchesWorkspaceCleanupFilters(makeFacets(), empty, FACET_NOW)).toBe(true)
  })

  it('filters by execution host, repo, and path prefix', () => {
    const remote = makeFacets({ worktree: { hostId: 'ssh:builder' } })
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.location.hostIds = ['ssh:builder']
      s.location.repoIds = ['repo-1']
      s.location.pathPrefix = '/repo/'
    })
    expect(matchesWorkspaceCleanupFilters(remote, state, FACET_NOW)).toBe(true)
    state.location.pathPrefix = '/other/'
    expect(matchesWorkspaceCleanupFilters(remote, state, FACET_NOW)).toBe(false)
    expect(matchesWorkspaceCleanupFilters(makeFacets(), state, FACET_NOW)).toBe(false)
  })
})

describe('safety filter', () => {
  it('supports any-of and none-of blocker selection', () => {
    const live = makeFacets({
      candidate: { blockers: ['live-agent', 'pinned'], tier: 'protected' }
    })
    const anyOf = filters((s) => {
      s.safety.dismissed = 'any'
      s.safety.blockers = ['live-agent']
      s.safety.blockerMode = 'any-of'
    })
    const noneOf = filters((s) => {
      s.safety.dismissed = 'any'
      s.safety.blockers = ['live-agent']
      s.safety.blockerMode = 'none-of'
    })
    expect(matchesWorkspaceCleanupFilters(live, anyOf, FACET_NOW)).toBe(true)
    expect(matchesWorkspaceCleanupFilters(live, noneOf, FACET_NOW)).toBe(false)
    expect(matchesWorkspaceCleanupFilters(makeFacets(), noneOf, FACET_NOW)).toBe(true)
  })

  it('includes dismissed rows by default and narrows them on demand', () => {
    const dismissed = makeFacets({ dismissed: true })
    expect(
      matchesWorkspaceCleanupFilters(
        dismissed,
        createDefaultWorkspaceCleanupFilterState(),
        FACET_NOW
      )
    ).toBe(true)
    const exclude = filters((s) => {
      s.safety.dismissed = 'exclude'
    })
    expect(matchesWorkspaceCleanupFilters(dismissed, exclude, FACET_NOW)).toBe(false)
    expect(matchesWorkspaceCleanupFilters(makeFacets(), exclude, FACET_NOW)).toBe(true)
    const only = filters((s) => {
      s.safety.dismissed = 'only'
    })
    expect(matchesWorkspaceCleanupFilters(dismissed, only, FACET_NOW)).toBe(true)
    expect(matchesWorkspaceCleanupFilters(makeFacets(), only, FACET_NOW)).toBe(false)
  })
})

describe('query pipeline', () => {
  it('bulk-selects label rows while preserving explicit exclusions', () => {
    const candidates = [
      makeFacetCandidate({
        worktreeId: 'repo-1::/dirty',
        blockers: ['dirty-files']
      }),
      makeFacetCandidate({
        worktreeId: 'repo-1::/pinned',
        blockers: ['pinned']
      }),
      makeFacetCandidate({
        worktreeId: 'repo-1::/unknown',
        git: {
          clean: null,
          upstreamAhead: null,
          upstreamBehind: null,
          checkedAt: null
        }
      }),
      makeFacetCandidate({
        worktreeId: 'repo-1::/active',
        blockers: ['active-workspace']
      }),
      makeFacetCandidate({
        worktreeId: 'repo-1::/agent',
        blockers: ['live-agent']
      }),
      makeFacetCandidate({
        worktreeId: 'repo-1::/ignored',
        blockers: ['dismissed']
      }),
      makeFacetCandidate({
        worktreeId: 'repo-1::/main',
        blockers: ['main-worktree']
      }),
      makeFacetCandidate({
        worktreeId: 'repo-1::/folder',
        blockers: ['folder-repo']
      }),
      makeFacetCandidate({
        worktreeId: 'repo-1::/remote',
        blockers: ['ssh-disconnected']
      })
    ]
    const result = queryWorkspaceCleanupCandidates(
      candidates,
      {
        filters: createDefaultWorkspaceCleanupFilterState(),
        sort: { field: 'name', direction: 'asc' }
      },
      {},
      FACET_NOW
    )
    const selectableIds = result.rows
      .filter((row) => result.selectableIdentities.includes(row.identity))
      .map((row) => row.worktreeId)

    expect(selectableIds).toEqual(
      expect.arrayContaining(['repo-1::/dirty', 'repo-1::/pinned', 'repo-1::/unknown'])
    )
    expect(selectableIds).not.toEqual(
      expect.arrayContaining([
        'repo-1::/active',
        'repo-1::/agent',
        'repo-1::/ignored',
        'repo-1::/main',
        'repo-1::/folder',
        'repo-1::/remote'
      ])
    )
    expect(canQueueWorkspaceCleanupCandidate(candidates[3])).toBe(true)
    expect(canQueueWorkspaceCleanupCandidate(candidates[4])).toBe(true)
    expect(canQueueWorkspaceCleanupCandidate(candidates[5])).toBe(true)
  })

  it('reports counts and selectable ids', () => {
    const rows = [
      makeNamedFacets('alpha'),
      makeNamedFacets('beta', {
        candidate: { blockers: ['dirty-files'], tier: 'review' }
      })
    ]
    expect(filterWorkspaceCleanupFacets(rows, ANY, FACET_NOW)).toHaveLength(2)
    const result = queryWorkspaceCleanupCandidates(
      buildWorkspaceCleanupFacetList([makeFacetCandidate()]).map((f) => f.candidate),
      { filters: ANY, sort: { field: 'name', direction: 'asc' } },
      {},
      FACET_NOW
    )
    expect(result.totalCount).toBe(1)
    expect(result.matchedCount).toBe(1)
    expect(result.selectableIdentities).toEqual([
      getWorkspaceCleanupHostIdentity('local', 'repo-1::/repo/alpha')
    ])
  })

  it('counts per-facet matches independently of the other groups', () => {
    const rows = [makeNamedFacets('alpha', { sizeBytes: 10 }), makeNamedFacets('beta')]
    const state = filters((s) => {
      s.safety.dismissed = 'any'
      s.size.includeUnsized = false
      s.git.states = ['dirty']
    })
    const counts = countWorkspaceCleanupFacetMatches(rows, state, FACET_NOW)
    expect(counts.size).toBe(1)
    expect(counts.git).toBe(0)
    expect(counts.safety).toBe(2)
  })
})
