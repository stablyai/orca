import { describe, expect, it } from 'vitest'
import {
  latestAgentTurnTimestamp,
  agentActivityReadState,
  changeAgentActivityReadState
} from './agent-activity-read-state'

const a = {
  paneKey: 'pane-a',
  worktreeId: 'main',
  hostId: 'local',
  latestActivityAt: 100,
  stateStartedAt: 100
}
const b = { ...a, paneKey: 'pane-b' }

describe('per-activity acknowledgement', () => {
  it('reads one pane without reading its sibling in main or overwriting a desktop read', () => {
    const ui = { acknowledgedAgentsByPaneKey: { 'pane-b': 200 }, manuallyUnreadTurnsByPaneKey: {} }
    const next = changeAgentActivityReadState(ui, a, true, 100)
    expect(next.acknowledgedAgentsByPaneKey).toEqual({ 'pane-a': 100, 'pane-b': 200 })
    expect(agentActivityReadState(a, next).unread).toBe(false)
    expect(agentActivityReadState(b, { acknowledgedAgentsByPaneKey: {} }).unread).toBe(true)
    expect(ui.acknowledgedAgentsByPaneKey).toEqual({ 'pane-b': 200 })
  })

  it('marks exactly one activity unread and preserves sibling acknowledgements and manual flags', () => {
    const next = changeAgentActivityReadState(
      {
        acknowledgedAgentsByPaneKey: { 'pane-a': 150, 'pane-b': 150 },
        manuallyUnreadTurnsByPaneKey: { 'pane-b': 80 }
      },
      a,
      false,
      100
    )
    expect(next.acknowledgedAgentsByPaneKey).toEqual({ 'pane-b': 150 })
    expect(next.manuallyUnreadTurnsByPaneKey).toEqual({ 'pane-a': 100, 'pane-b': 80 })
    expect(agentActivityReadState(a, next).unread).toBe(true)
    expect(agentActivityReadState(b, next).unread).toBe(false)
  })

  it('keeps activity that arrived after the observed read boundary unread', () => {
    const newer = { ...a, latestActivityAt: 200, stateStartedAt: 200 }
    const next = changeAgentActivityReadState({ acknowledgedAgentsByPaneKey: {} }, newer, true, 100)
    expect(next.acknowledgedAgentsByPaneKey).toEqual({ 'pane-a': 100 })
    expect(agentActivityReadState(newer, next).unread).toBe(true)
    const read = changeAgentActivityReadState(next, newer, true, 200)
    expect(agentActivityReadState(newer, read).unread).toBe(false)
  })

  it('uses state history rather than a heartbeat clock and clears only the explicit manual unread', () => {
    expect(
      latestAgentTurnTimestamp({ stateStartedAt: 100, stateHistory: [{ startedAt: 200 }] })
    ).toBe(200)
    const next = changeAgentActivityReadState(
      {
        acknowledgedAgentsByPaneKey: {},
        manuallyUnreadTurnsByPaneKey: { 'pane-a': 100, 'pane-b': 80 }
      },
      a,
      true,
      100
    )
    expect(next.manuallyUnreadTurnsByPaneKey).toEqual({ 'pane-b': 80 })
  })
})
