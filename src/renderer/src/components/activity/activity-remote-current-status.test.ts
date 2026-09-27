// Production path: buildActivityEvents drops a non-fresh working row from the
// live snapshot, then the history done event is all the old classifier could see.
// That is a stale or unconfirmed row mislabeled Done. It is not evidence that a
// fresh host working row failed to propagate.
import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildActivityEvents } from './activity-event-builder'
import { buildAgentPaneThreads } from './activity-thread-builder'
import { buildActivityThreadGroups } from './activity-thread-grouping'
import { activityThreadStatusId } from './activity-thread-presentation'
import {
  LEAF_ID,
  makeRepo,
  makeTabWithIds,
  makeWorktreeWithId
} from './ActivityPrototypePage-test-fixtures'
import type { AgentPaneThread } from './activity-thread-types'

const NOW = 1_700_000_000_000
const PANE_KEY = makePaneKey('tab-omp', LEAF_ID)

function groupKey(entry: AgentStatusEntry, worktreeId: string, displayName: string): string {
  const repo = makeRepo()
  const worktree = makeWorktreeWithId(worktreeId, repo.id, displayName)
  const tab = makeTabWithIds('tab-omp', worktree.id, 'OMP')
  const { events, liveAgentByPaneKey, paneEntryByPaneKey } = buildActivityEvents({
    agentStatusByPaneKey: { [entry.paneKey]: entry },
    retainedAgentsByPaneKey: {},
    tabsByWorktree: { [worktree.id]: [tab] },
    worktreeMap: new Map([[worktree.id, worktree]]),
    repoMap: new Map([[repo.id, repo]]),
    acknowledgedAgentsByPaneKey: {},
    now: NOW
  })
  const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey, paneEntryByPaneKey })
  return buildActivityThreadGroups(threads, 'status')[0]?.key ?? 'missing'
}

function ompEntry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'continue the datadog integration',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey: PANE_KEY,
    agentType: 'omp',
    stateHistory: [
      {
        state: 'done',
        prompt: 'first pass finished',
        startedAt: NOW - 60_000,
        observedAt: NOW - 60_000
      }
    ],
    ...overrides
  }
}

describe('remote activity current status versus a completion receipt', () => {
  it('keeps a fresh working row under Working when an older completion is still on the pane', () => {
    expect(groupKey(ompEntry({}), 'wt-cem-528', 'cem-528-datadog-integration')).toBe('working')
  })

  it('reads an expired working row as no recent update, not Working and not its old completion', () => {
    const staleAt = NOW - AGENT_STATUS_STALE_AFTER_MS - 5_000
    const key = groupKey(
      ompEntry({
        updatedAt: staleAt,
        stateStartedAt: staleAt,
        stateHistory: [
          {
            state: 'done',
            prompt: 'first pass finished',
            startedAt: staleAt - 60_000,
            observedAt: staleAt - 60_000
          }
        ]
      }),
      'wt-cem-528',
      'cem-528-datadog-integration'
    )

    expect(key).not.toBe('done')
    expect(key).not.toBe('working')
    expect(key).toBe('unverifiable')
  })

  it('does not turn a hydrated unconfirmed working row into the previous completion', () => {
    const key = groupKey(
      ompEntry({ restoredUnconfirmed: true, updatedAt: NOW - 1_000 }),
      'wt-cem-528',
      'cem-528-datadog-integration'
    )

    expect(key).not.toBe('done')
    expect(key).toBe('unverifiable')
  })

  it('still groups a current completion as Done and keeps that separate from another host', () => {
    const repo = makeRepo()
    const remote = makeWorktreeWithId('wt-remote', repo.id, 'cem-528-datadog-integration')
    const local = makeWorktreeWithId('wt-local', repo.id, 'local-notes')
    const remoteTab = makeTabWithIds('tab-omp', remote.id, 'OMP')
    const localTab = makeTabWithIds('tab-local', local.id, 'Claude')
    const localPane = makePaneKey('tab-local', LEAF_ID)
    const { events, liveAgentByPaneKey, paneEntryByPaneKey } = buildActivityEvents({
      agentStatusByPaneKey: {
        [PANE_KEY]: ompEntry({ state: 'done', prompt: 'shipped', stateHistory: [] }),
        [localPane]: ompEntry({
          paneKey: localPane,
          state: 'working',
          prompt: 'local follow-up',
          agentType: 'claude',
          stateHistory: []
        })
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: {
        [remote.id]: [remoteTab],
        [local.id]: [localTab]
      },
      worktreeMap: new Map([
        [remote.id, remote],
        [local.id, local]
      ]),
      repoMap: new Map([[repo.id, repo]]),
      acknowledgedAgentsByPaneKey: { [PANE_KEY]: NOW },
      now: NOW
    })
    const threads = buildAgentPaneThreads({ events, liveAgentByPaneKey, paneEntryByPaneKey })
    const groups = buildActivityThreadGroups(threads, 'status')

    expect(groups.map((group) => group.key)).toEqual(['working', 'done'])
    expect(groups[1]?.threads[0]?.paneKey).toBe(PANE_KEY)
    expect(groups[1]?.threads[0]?.unread).toBe(false)
    expect(groups[0]?.threads[0]?.paneKey).toBe(localPane)
  })

  it('reads an expired folder-workspace working row as no recent update', () => {
    const staleAt = NOW - AGENT_STATUS_STALE_AFTER_MS - 5_000
    expect(
      groupKey(
        ompEntry({ updatedAt: staleAt, stateStartedAt: staleAt }),
        folderWorkspaceKey('docs-folder'),
        'Docs folder'
      )
    ).toBe('unverifiable')
  })

  it('does not invent Done when a thread has no status evidence', () => {
    const worktree = makeWorktreeWithId('wt-1', 'repo-1', 'feature')
    const thread = {
      paneKey: PANE_KEY,
      paneTitle: 'OMP',
      worktree,
      repo: null,
      tab: makeTabWithIds('tab-omp', worktree.id),
      agentType: 'omp',
      currentAgentState: null,
      currentAgentEntry: null,
      responsePreview: '',
      latestTimestamp: 0,
      latestEvent: null,
      events: [],
      unread: false
    } satisfies AgentPaneThread

    expect(activityThreadStatusId(thread)).toBe('unverifiable')
  })
})
