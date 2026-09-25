import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { buildPaneActivityEvents } from '@/components/activity/activity-pane-events'
import { makeTab, makeWorktree } from '@/components/activity/ActivityPrototypePage-test-fixtures'
import type { AppState } from '../types'
import { agentMeta, agentTitle } from '@/components/activity/activity-thread-presentation'
import { isPassiveCompletedHibernationEvidence } from '@/lib/sleeping-agent-pane-ownership'
import { resolveAgentStatusLiveEntryStateHistory } from './agent-status-live-entry-state-history'
import { deriveAgentStatusLiveFacts } from './agent-status-live-facts'
import {
  recoveryRecordMatches,
  sleepingRecordsEquivalentIgnoringCaptureTime
} from './agent-status-recovery-equivalence'
import {
  isValidCompletedAgentHibernationEntry,
  manualSleepCaptureEntry,
  sleepingRecordFromEntry
} from './agent-status-sleeping-records'

// Every copy of a row's verdict carries it: history, sleep records and their equality checks.
// A copy that kept only `interrupted` would read a failure as a clean finish.
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
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

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: 'ship it',
    state: 'done',
    capturedAt: 3_000,
    updatedAt: 2_000,
    origin: 'live',
    ...overrides
  }
}

describe('a failed done keeps its verdict in every copy', () => {
  it('copies the verdict into history with the state it leaves', () => {
    const { history } = resolveAgentStatusLiveEntryStateHistory(
      failedDone(),
      { state: 'working' },
      3_000
    )
    expect(history.at(-1)).toMatchObject({ state: 'done', outcome: 'failure' })
  })

  it('draws a history done as failed, not with the live row verdict', () => {
    const entry: AgentStatusEntry = {
      ...failedDone({ state: 'working', stateStartedAt: 3_000, mainAgent: undefined }),
      stateHistory: [{ state: 'done', prompt: 'ship it', startedAt: 2_000, outcome: 'failure' }]
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
    expect(done && agentTitle(done)).toBe('Agent failed')
    expect(done && agentMeta(done)).toBe('Claude failed')
  })

  it('records the verdict on a sleep record and never hibernates a failed pane', () => {
    const sleeping = sleepingRecordFromEntry({
      state: STATE,
      entry: failedDone(),
      worktreeId: 'wt-1',
      tab: makeTab(),
      capturedAt: 3_000,
      origin: 'live'
    })
    expect(sleeping).toMatchObject({ outcome: 'failure' })
    expect(isValidCompletedAgentHibernationEntry(failedDone())).toBe(false)
    // A live checkpoint of a turn that failed is still work the user owns.
    expect(isPassiveCompletedHibernationEvidence(record({ outcome: 'failure' }))).toBe(false)
    expect(isPassiveCompletedHibernationEvidence(record())).toBe(true)
  })

  it('leaves the verdict behind when the user sleeps the workspace', () => {
    expect(manualSleepCaptureEntry(failedDone(), 4_000).mainAgent).not.toHaveProperty('outcome')
  })

  it('re-sorts and re-retains a done whose verdict changed under an unchanged flag', () => {
    const clean = failedDone({
      mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 2_000 }
    })
    const facts = deriveAgentStatusLiveFacts({
      state: STATE,
      paneKey: PANE_KEY,
      entry: failedDone(),
      existing: clean,
      launchConfigSource: undefined,
      retainsResumableRecoveryIdentity: false,
      commandCodeNewTurn: false,
      updatedAt: 2_000
    })
    expect(facts.retentionRelevantChange).toBe(true)
  })

  it('treats a verdict change as a different record even when interrupted did not move', () => {
    const clean = record({ outcome: 'success' })
    const failed = record({ outcome: 'failure' })
    expect(sleepingRecordsEquivalentIgnoringCaptureTime(clean, failed)).toBe(false)
    expect(recoveryRecordMatches(clean, failed)).toBe(false)
    expect(sleepingRecordsEquivalentIgnoringCaptureTime(failed, { ...failed })).toBe(true)
  })
})
