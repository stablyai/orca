import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentTurnOutcome } from '../../../../shared/agent-turn-outcome'
import {
  buildActivityThreadGroups,
  getActivityThreadGroup,
  activityThreadMatchesSearchQuery,
  getThreadSearchTextComputeCount
} from './activity-thread-grouping'
import { activityThreadStatusId, activityThreadRowCopy } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'
import {
  makeRepo,
  makeTabWithIds,
  makeThreads,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2,
  PANE_KEY_3,
  makeTab
} from './ActivityPrototypePage-test-fixtures'
import { buildActivityEvents } from './activity-event-builder'
import { buildAgentPaneThreads } from './activity-thread-builder'
import { formatShortTimeAgo } from '@/lib/short-time-ago'

{
  type StatusFixture = {
    paneKey: string
    state: AgentStatusEntry['state']
    at: number
    /** The main agent's verdict on its finished turn. */
    outcome?: AgentTurnOutcome
  }

  function makeStatusThreads(fixtures: StatusFixture[]): AgentPaneThread[] {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const tabs = fixtures.map((_fixture, index) => makeTabWithIds(`tab-${index + 1}`, worktree.id))
    const agentStatusByPaneKey = Object.fromEntries(
      fixtures.map((fixture) => [
        fixture.paneKey,
        {
          state: fixture.state,
          prompt: 'Prompt',
          updatedAt: fixture.at,
          stateStartedAt: fixture.at,
          paneKey: fixture.paneKey,
          terminalTitle: 'Claude',
          stateHistory: [],
          agentType: 'claude',
          ...(fixture.outcome
            ? {
                mainAgent: {
                  state: fixture.state,
                  outcome: fixture.outcome,
                  stateStartedAt: fixture.at
                }
              }
            : {})
        } satisfies AgentStatusEntry
      ])
    )
    return makeThreads(
      buildActivityEvents({
        agentStatusByPaneKey,
        retainedAgentsByPaneKey: {},
        tabsByWorktree: { [worktree.id]: tabs },
        worktreeMap: new Map([[worktree.id, worktree]]),
        repoMap: new Map([[repo.id, repo]]),
        acknowledgedAgentsByPaneKey: {},
        now: Math.max(...fixtures.map((fixture) => fixture.at))
      })
    )
  }

  describe('status group order', () => {
    it('ranks Working above Done even when the Done thread is newer', () => {
      const threads = makeStatusThreads([
        { paneKey: PANE_KEY, state: 'working', at: 1_000 },
        { paneKey: PANE_KEY_2, state: 'done', at: 5_000 }
      ])
      expect(threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_2, PANE_KEY])

      const groups = buildActivityThreadGroups(threads, 'status')

      expect(groups.map((group) => group.key)).toEqual(['working', 'done'])
    })

    it("ranks a user's Stop and a replaced turn below live work, above Done", () => {
      for (const outcome of ['cancellation', 'superseded'] as const) {
        const groups = buildActivityThreadGroups(
          makeStatusThreads([
            { paneKey: PANE_KEY, state: 'working', at: 1_000 },
            { paneKey: PANE_KEY_2, state: 'done', at: 3_000 },
            { paneKey: PANE_KEY_3, state: 'done', at: 5_000, outcome }
          ]),
          'status'
        )

        expect(
          groups.map((group) => group.key),
          outcome
        ).toEqual(['working', 'interrupted', 'done'])
      }
    })

    it('keeps a failure and an unproven end above live work', () => {
      const groups = buildActivityThreadGroups(
        makeStatusThreads([
          { paneKey: PANE_KEY, state: 'working', at: 5_000 },
          { paneKey: PANE_KEY_2, state: 'done', at: 1_000, outcome: 'unconfirmed' },
          { paneKey: PANE_KEY_3, state: 'done', at: 3_000, outcome: 'interruption' }
        ]),
        'status'
      )

      expect(groups.map((group) => group.key)).toEqual(['failed', 'unconfirmed', 'working'])
    })

    it('keeps attention headers in a fixed order regardless of thread recency', () => {
      const newerBlocked = buildActivityThreadGroups(
        makeStatusThreads([
          { paneKey: PANE_KEY, state: 'waiting', at: 1_000 },
          { paneKey: PANE_KEY_2, state: 'blocked', at: 5_000 }
        ]),
        'status'
      )
      const newerWaiting = buildActivityThreadGroups(
        makeStatusThreads([
          { paneKey: PANE_KEY, state: 'waiting', at: 5_000 },
          { paneKey: PANE_KEY_2, state: 'blocked', at: 1_000 }
        ]),
        'status'
      )

      expect(newerBlocked.map((group) => group.key)).toEqual(['waiting', 'blocked'])
      expect(newerWaiting.map((group) => group.key)).toEqual(['waiting', 'blocked'])
    })

    it('keeps newest-first thread order inside each group', () => {
      const groups = buildActivityThreadGroups(
        makeStatusThreads([
          { paneKey: PANE_KEY, state: 'done', at: 1_000 },
          { paneKey: PANE_KEY_2, state: 'working', at: 2_000 },
          { paneKey: PANE_KEY_3, state: 'done', at: 3_000 }
        ]),
        'status'
      )

      expect(groups.map((group) => group.key)).toEqual(['working', 'done'])
      expect(groups[1].threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_3, PANE_KEY])
    })

    it('gives every status group a header state equal to its rows', () => {
      const groups = buildActivityThreadGroups(
        makeStatusThreads([
          { paneKey: PANE_KEY, state: 'blocked', at: 1_000 },
          { paneKey: PANE_KEY_2, state: 'working', at: 2_000 },
          { paneKey: PANE_KEY_3, state: 'done', at: 3_000 }
        ]),
        'status'
      )

      expect(groups.map((group) => group.state)).toEqual(['blocked', 'working', 'done'])
      for (const group of groups) {
        for (const thread of group.threads) {
          expect(activityThreadStatusId(thread)).toBe(group.state)
        }
      }
    })

    it('does not rank or set a header state outside status mode', () => {
      const threads = makeStatusThreads([
        { paneKey: PANE_KEY, state: 'working', at: 1_000 },
        { paneKey: PANE_KEY_2, state: 'done', at: 5_000 }
      ])

      for (const groupBy of ['project', 'worktree', 'agent'] as const) {
        const groups = buildActivityThreadGroups(threads, groupBy)
        expect(groups[0].state).toBeUndefined()
        expect(groups[0].threads.map((thread) => thread.paneKey)).toEqual([PANE_KEY_2, PANE_KEY])
        expect(getActivityThreadGroup(threads[0], groupBy).state).toBeUndefined()
      }
    })
  })
}

{
  function makeThread(paneKey: string, paneTitle: string): AgentPaneThread {
    return {
      paneKey,
      tab: makeTab(),
      worktree: makeWorktree(),
      repo: null,
      currentAgentState: null,
      currentAgentEntry: null,
      latestEvent: null,
      latestTimestamp: 1_000,
      agentType: 'claude',
      unread: false,
      paneTitle,
      responsePreview: 'x'.repeat(2_000),
      events: []
    }
  }

  describe('activity thread search text cache', () => {
    it('builds a thread searchable text once per thread identity across keystrokes', () => {
      const thread = makeThread('tab-1:leaf-1', 'Refactor billing pipeline')
      const before = getThreadSearchTextComputeCount()
      // Simulate typing a query letter by letter against the same thread objects.
      for (const searchQuery of ['r', 're', 'ref', 'refa', 'refac']) {
        expect(activityThreadMatchesSearchQuery({ thread, searchQuery })).toBe(true)
      }
      expect(getThreadSearchTextComputeCount() - before).toBe(1)
    })

    it('recomputes when thread data changes (new thread identity)', () => {
      const before = getThreadSearchTextComputeCount()
      const first = makeThread('tab-1:leaf-1', 'First title')
      const rebuilt = makeThread('tab-1:leaf-1', 'Second title')
      expect(activityThreadMatchesSearchQuery({ thread: first, searchQuery: 'first' })).toBe(true)
      expect(activityThreadMatchesSearchQuery({ thread: rebuilt, searchQuery: 'second' })).toBe(
        true
      )
      expect(getThreadSearchTextComputeCount() - before).toBe(2)
    })

    it('keeps match semantics: state labels, workspace, and previews still match', () => {
      const thread = makeThread('tab-1:leaf-1', 'My task')
      expect(activityThreadMatchesSearchQuery({ thread, searchQuery: 'feature' })).toBe(true)
      expect(activityThreadMatchesSearchQuery({ thread, searchQuery: 'zzz-no-match' })).toBe(false)
      expect(activityThreadMatchesSearchQuery({ thread, searchQuery: '' })).toBe(true)
    })
  })
}

{
  type Ending = 'cancellation' | 'interruption'

  function doneEntry(paneKey: string, outcome: Ending, at: number): AgentStatusEntry {
    return {
      state: 'done',
      prompt: 'Prompt',
      terminalTitle: 'Claude',
      stateHistory: [],
      agentType: 'claude',
      paneKey,
      interrupted: outcome === 'cancellation',
      updatedAt: at,
      stateStartedAt: at,
      mainAgent: { state: 'done', outcome, stateStartedAt: at }
    }
  }

  /** Status groups for two ended panes, `newer` the most recent. */
  function statusGroups(newer: Ending, older: Ending) {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const { events, liveAgentByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: {
        [PANE_KEY]: doneEntry(PANE_KEY, newer, 3_000),
        [PANE_KEY_2]: doneEntry(PANE_KEY_2, older, 2_000)
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [worktree.id]: [makeTabWithIds('tab-1', worktree.id), makeTabWithIds('tab-2', worktree.id)]
      },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })
    return buildActivityThreadGroups(
      buildAgentPaneThreads({ events, liveAgentByPaneKey }),
      'status'
    )
  }

  describe('the status group headers', () => {
    it.each([
      { newer: 'cancellation', older: 'interruption' },
      { newer: 'interruption', older: 'cancellation' }
    ] as const)(
      "never mixes a user's Stop with a crash, whichever is newest ($newer newest)",
      ({ newer, older }) => {
        const groups = statusGroups(newer, older)

        // A crash sits with failures; the Stop alone heads Interrupted, below it.
        expect(groups.map((group) => [group.key, group.state, group.label])).toEqual([
          ['failed', 'failed', 'Failed'],
          ['interrupted', 'interrupted', 'Interrupted']
        ])
      }
    )

    it("heads a group of user's Stops with the interrupted glyph", () => {
      const groups = statusGroups('cancellation', 'cancellation')

      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ key: 'interrupted', state: 'interrupted' })
    })
  })
}

{
  function makeThread(overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
    const worktree = makeWorktree()
    return {
      paneKey: PANE_KEY,
      paneTitle: 'low hanging issues',
      agentType: 'codex',
      worktree,
      repo: makeRepo(),
      tab: makeTabWithIds('tab-1', worktree.id),
      events: [],
      latestEvent: null,
      latestTimestamp: 1_000,
      currentAgentState: null,
      currentAgentEntry: null,
      unread: false,
      responsePreview: '',
      ...overrides
    }
  }

  describe('formatShortTimeAgo', () => {
    it('uses short units', () => {
      const now = 1_000_000
      expect(formatShortTimeAgo(now - 10_000, now)).toBe('now')
      expect(formatShortTimeAgo(now - 5 * 60_000, now)).toBe('5m')
      expect(formatShortTimeAgo(now - 20 * 60 * 60_000, now)).toBe('20h')
      expect(formatShortTimeAgo(now - 2 * 24 * 60 * 60_000, now)).toBe('2d')
    })
  })

  describe('activityThreadRowCopy', () => {
    it('leads with the task and the last activity, not project or workspace', () => {
      const copy = activityThreadRowCopy(
        makeThread({
          responsePreview: 'Filed 8 issues from the audit.'
        })
      )
      expect(copy.taskTitle).toBe('low hanging issues')
      expect(copy.statusLine).toBe('Filed 8 issues from the audit.')
      expect(copy.statusKind).toBe('message')
      expect(copy.needsAttention).toBe(false)
      expect(copy.workspaceLabel).toBe('feature')
    })

    it('names the live tool while working', () => {
      const copy = activityThreadRowCopy(
        makeThread({
          paneTitle: 'Fix checkout race',
          currentAgentState: 'working',
          responsePreview: 'Edit src/checkout/session.ts'
        })
      )
      expect(copy.statusKind).toBe('tool')
      expect(copy.statusLine).toBe('Edit src/checkout/session.ts')
    })

    it('falls back to a state label when a live agent has no preview', () => {
      const copy = activityThreadRowCopy(
        makeThread({
          paneTitle: 'Review PR 1842',
          currentAgentState: 'waiting',
          responsePreview: ''
        })
      )
      expect(copy.statusKind).toBe('state')
      expect(copy.statusLine).toBe('Waiting for input')
      expect(copy.needsAttention).toBe(true)
    })

    it('does not invent a status line for a finished agent with no reply', () => {
      const copy = activityThreadRowCopy(
        makeThread({ currentAgentState: null, responsePreview: '' })
      )
      expect(copy.statusKind).toBe('none')
      expect(copy.statusLine).toBe('')
    })

    it('does not repeat the task title as the last-message line', () => {
      const copy = activityThreadRowCopy(
        makeThread({
          paneTitle: 'low hanging issues',
          responsePreview: 'low hanging issues'
        })
      )
      expect(copy.statusKind).toBe('none')
      expect(copy.statusLine).toBe('')
    })
  })
}
