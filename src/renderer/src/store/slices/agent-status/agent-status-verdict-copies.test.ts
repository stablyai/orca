import { describe, expect, it } from 'vitest'

import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { parseWorkspaceSession } from '../../../../../shared/workspace-session-schema'
import { buildPaneActivityEvents } from '@/components/activity/activity-pane-events'
import { makeTab, makeWorktree } from '@/components/activity/ActivityPrototypePage-test-fixtures'
import type { AppState } from '../../types'
import { agentMeta, agentTitle } from '@/components/activity/activity-thread-presentation'
import '@/lib/sleeping-agent-pane-ownership'
import { resolveAgentStatusLiveEntryStateHistory } from '../../../../../shared/agent-status-live-entry-state-history'
import './agent-status-live-facts'
import '../../../../../shared/agent-resume-record-equivalence'
import { sleepingRecordFromEntry } from './agent-status-sleeping-records'

// Every copy of a row's verdict carries it: history, sleep records and their equality checks.
// A copy that kept only `interrupted` would read a failure as a clean finish.
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const FAILED_MAIN_AGENT = { state: 'done', outcome: 'failure', stateStartedAt: 2_000 } as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these readers touch only the three maps given; every tab lookup is answered by the tab the caller passes.
const STATE = {
  sleepingAgentSessionsByPaneKey: {},
  migrationUnsupportedByPtyId: {},
  tabsByWorktree: {}
} as unknown as AppState

function failedDone(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'done',
    prompt: 'ship it',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    stateHistory: [],
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 2_000 },
    ...overrides
  }
}

describe('a failed done keeps its verdict in every copy', () => {
  it('draws a history done as failed from its own main agent status, not the live row', () => {
    // The main agent failed before the row settled, so its clock differs from the row's.
    const mainAgent = { ...FAILED_MAIN_AGENT, stateStartedAt: 1_500 }
    const entry: AgentStatusEntry = {
      ...failedDone({ state: 'working', stateStartedAt: 3_000, mainAgent: undefined }),
      stateHistory: resolveAgentStatusLiveEntryStateHistory(
        failedDone({ mainAgent }),
        { state: 'working' },
        3_000
      ).history
    }
    const events = buildPaneActivityEvents({
      entry,
      worktree: makeWorktree(),
      repo: null,
      tab: makeTab(),
      agentType: 'claude',
      agentAlive: true,
      acknowledgedAt: 0,
      clearedAt: 0,
      liveState: null
    })
    const done = events.find((event) => event.state === 'done')
    expect(done?.entry.mainAgent).toEqual(mainAgent)
    expect(done && agentTitle(done)).toBe('Agent failed')
    expect(done && agentMeta(done)).toBe('Claude failed')
  })

  it('keeps the main agent status through persistence, and drops only a malformed one', () => {
    const hydrate = (sleeping: unknown) => {
      const result = parseWorkspaceSession({
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        sleepingAgentSessionsByPaneKey: { [PANE_KEY]: sleeping }
      })
      return result.ok ? result.value.sleepingAgentSessionsByPaneKey?.[PANE_KEY] : undefined
    }
    const sleeping = sleepingRecordFromEntry({
      state: STATE,
      entry: failedDone(),
      worktreeId: 'wt-1',
      tab: makeTab(),
      capturedAt: 3_000,
      origin: 'live'
    })
    expect(hydrate(sleeping)?.mainAgent).toEqual(FAILED_MAIN_AGENT)
    const malformed = hydrate({ ...sleeping, mainAgent: { state: 'done', outcome: 'failure' } })
    expect(malformed).toMatchObject({ paneKey: PANE_KEY, state: 'done', origin: 'live' })
    expect(malformed?.mainAgent).toBeUndefined()
  })
})
