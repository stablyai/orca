import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { AgentStatusObservation } from '../../../../shared/agent-status-observation'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { buildWorktreeAgentRows } from '@/components/sidebar/worktree-agent-rows'
import { getAgentDotState } from '@/components/sidebar/worktree-card-agent-summary'
import { resolveAttention } from '@/components/sidebar/smart-attention'
import { createTestStore, makeTab } from './store-test-helpers'

// The safety argument for STA-4293 step 1 in one file: an observation-stamped row and an
// unstamped row must be indistinguishable to every consumer that reads status today.

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const OBSERVATION: AgentStatusObservation = {
  origin: 'hook',
  authorityId: 'main-agent-hooks:test',
  incarnation: 3,
  revision: 17,
  observedAt: 1_700_000_000_000,
  boundary: true,
  kind: 'transition'
}

const STATES: AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']

function withoutObservation(entry: AgentStatusEntry): Omit<AgentStatusEntry, 'observation'> {
  const { observation: _observation, ...rest } = entry
  return rest
}

function applyStatus(
  state: AgentStatusState,
  observation: AgentStatusObservation | undefined
): {
  entry: AgentStatusEntry
  agentStatusEpoch: number
  sortEpoch: number
} {
  const store = createTestStore()
  store.getState().setAgentStatus(PANE_KEY, {
    state: 'working',
    prompt: 'first turn',
    agentType: 'claude',
    ...(observation ? { observation } : {})
  })
  store.getState().setAgentStatus(PANE_KEY, {
    state,
    prompt: 'first turn',
    agentType: 'claude',
    lastAssistantMessage: state === 'done' ? 'all set' : undefined,
    ...(observation ? { observation } : {})
  })
  const snapshot = store.getState()
  const entry = snapshot.agentStatusByPaneKey[PANE_KEY]
  if (!entry) {
    throw new Error(`expected a live entry for ${state}`)
  }
  return {
    entry,
    agentStatusEpoch: snapshot.agentStatusEpoch,
    sortEpoch: snapshot.sortEpoch
  }
}

describe('agent status observation is behavior-neutral', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(STATES)('produces an identical %s entry apart from the observation field', (state) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)

    const stamped = applyStatus(state, OBSERVATION)
    vi.setSystemTime(1_700_000_000_000)
    const unstamped = applyStatus(state, undefined)

    expect(withoutObservation(stamped.entry)).toEqual(withoutObservation(unstamped.entry))
    expect(stamped.entry.observation).toEqual(OBSERVATION)
    expect(unstamped.entry.observation).toBeUndefined()
    // Why: an extra epoch tick is an extra render across every aggregate consumer — that
    // would be a behavior change even though no rendered value differs.
    expect(stamped.agentStatusEpoch).toBe(unstamped.agentStatusEpoch)
    expect(stamped.sortEpoch).toBe(unstamped.sortEpoch)
  })

  it.each(STATES)('resolves %s identically for freshness, rows, dot and attention', (state) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const stamped = applyStatus(state, OBSERVATION).entry
    vi.setSystemTime(1_700_000_000_000)
    const unstamped = applyStatus(state, undefined).entry
    vi.useRealTimers()

    const now = 1_700_000_000_000
    const tabs = [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]

    for (const at of [now, now + AGENT_STATUS_STALE_AFTER_MS + 1]) {
      expect(isExplicitAgentStatusFresh(stamped, at, AGENT_STATUS_STALE_AFTER_MS)).toBe(
        isExplicitAgentStatusFresh(unstamped, at, AGENT_STATUS_STALE_AFTER_MS)
      )

      const stampedRows = buildWorktreeAgentRows({
        tabs,
        entries: [stamped],
        retained: [],
        now: at
      })
      const unstampedRows = buildWorktreeAgentRows({
        tabs,
        entries: [unstamped],
        retained: [],
        now: at
      })
      // Why: an empty-vs-empty comparison would pass without proving anything.
      expect(stampedRows).toHaveLength(1)
      expect(stampedRows.map((row) => ({ ...row, entry: withoutObservation(row.entry) }))).toEqual(
        unstampedRows.map((row) => ({ ...row, entry: withoutObservation(row.entry) }))
      )
      expect(stampedRows.map(getAgentDotState)).toEqual(unstampedRows.map(getAgentDotState))

      expect(resolveAttention([{ kind: 'hook', entry: stamped }], at)).toEqual(
        resolveAttention([{ kind: 'hook', entry: unstamped }], at)
      )
    }
  })

  it('leaves an unstamped entry resolving exactly as it does today', () => {
    // Why: old hosts, persisted rehydration, title-derived rows and subagent rows all reach
    // consumers with no observation at all; that path must not have moved.
    const now = 1_700_000_000_000
    const entry: AgentStatusEntry = {
      paneKey: PANE_KEY,
      state: 'blocked',
      prompt: 'needs approval',
      updatedAt: now,
      stateStartedAt: now,
      stateHistory: [],
      agentType: 'codex'
    }

    expect(isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)).toBe(true)
    expect(resolveAttention([{ kind: 'hook', entry }], now)).toMatchObject({ cls: 1 })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })],
      entries: [entry],
      retained: [],
      now
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].entry.observation).toBeUndefined()
    expect(getAgentDotState(rows[0])).toBe('blocked')
  })

  it('does not carry a previous observation onto an unstamped write', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    store.getState().setAgentStatus(PANE_KEY, {
      state: 'working',
      prompt: 'p',
      agentType: 'claude',
      observation: OBSERVATION
    })
    store.getState().setAgentStatus(PANE_KEY, { state: 'done', prompt: 'p', agentType: 'claude' })

    // Why: inheriting it would let a stale authority claim ordering over a row it never observed.
    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.observation).toBeUndefined()
  })
})
