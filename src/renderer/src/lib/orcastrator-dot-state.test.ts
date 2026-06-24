import { describe, it, expect } from 'vitest'
import { deriveOrcastratorDotState } from './orcastrator-dot-state'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { OrchestrationActivity } from '../../../shared/runtime-types'

function entry(
  paneKey: string,
  state: AgentStatusEntry['state'],
  stateStartedAt: number
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: stateStartedAt,
    stateStartedAt,
    paneKey,
    stateHistory: []
  }
}

function activity(overrides: Partial<OrchestrationActivity> = {}): OrchestrationActivity {
  return {
    runId: 'run_1',
    pendingTasks: 0,
    activeDispatches: 0,
    staleDispatches: 0,
    ...overrides
  }
}

const TAB_IDS = ['tab1']

describe('deriveOrcastratorDotState', () => {
  it('returns idle when there is no agent and no run', () => {
    expect(deriveOrcastratorDotState(TAB_IDS, {}, {})).toBe('idle')
  })

  it('never returns done — a finished turn with no run is idle, not a checkmark', () => {
    const agents = { 'tab1:leaf1': entry('tab1:leaf1', 'done', 100) }
    expect(deriveOrcastratorDotState(TAB_IDS, agents, {})).toBe('idle')
  })

  it('shows supervising when the turn ended but a run is still in flight', () => {
    const agents = { 'tab1:leaf1': entry('tab1:leaf1', 'done', 100) }
    const activityMap = { 'tab1:leaf1': activity({ activeDispatches: 1 }) }
    expect(deriveOrcastratorDotState(TAB_IDS, agents, activityMap)).toBe('supervising')
  })

  it('shows supervising even with no live agent when a run is in flight', () => {
    const activityMap = { 'tab1:leaf1': activity({ pendingTasks: 2 }) }
    expect(deriveOrcastratorDotState(TAB_IDS, {}, activityMap)).toBe('supervising')
  })

  it('shows stalled when a dispatched worker heartbeat is hung', () => {
    const agents = { 'tab1:leaf1': entry('tab1:leaf1', 'done', 100) }
    const activityMap = { 'tab1:leaf1': activity({ activeDispatches: 1, staleDispatches: 1 }) }
    expect(deriveOrcastratorDotState(TAB_IDS, agents, activityMap)).toBe('stalled')
  })

  it('foreground working beats background supervision', () => {
    const agents = { 'tab1:leaf1': entry('tab1:leaf1', 'working', 100) }
    const activityMap = { 'tab1:leaf1': activity({ activeDispatches: 1 }) }
    expect(deriveOrcastratorDotState(TAB_IDS, agents, activityMap)).toBe('working')
  })

  it('a director awaiting the user (waiting) beats background supervision', () => {
    const agents = { 'tab1:leaf1': entry('tab1:leaf1', 'waiting', 100) }
    const activityMap = { 'tab1:leaf1': activity({ activeDispatches: 1 }) }
    expect(deriveOrcastratorDotState(TAB_IDS, agents, activityMap)).toBe('waiting')
  })

  it('blocked beats background supervision', () => {
    const agents = { 'tab1:leaf1': entry('tab1:leaf1', 'blocked', 100) }
    const activityMap = { 'tab1:leaf1': activity({ staleDispatches: 1 }) }
    expect(deriveOrcastratorDotState(TAB_IDS, agents, activityMap)).toBe('blocked')
  })

  it('ignores activity whose coordinator pane belongs to another worktree', () => {
    const agents = { 'tab1:leaf1': entry('tab1:leaf1', 'done', 100) }
    const activityMap = { 'otherTab:leaf1': activity({ activeDispatches: 1 }) }
    expect(deriveOrcastratorDotState(TAB_IDS, agents, activityMap)).toBe('idle')
  })
})
