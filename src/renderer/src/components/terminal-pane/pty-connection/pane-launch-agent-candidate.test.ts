import { describe, expect, it } from 'vitest'
import {
  paneShouldAnswerOscColorQueries,
  resolvePaneLaunchAgentCandidate,
  resolvePaneLaunchTuiAgent,
  type PaneLaunchAgentPaneSlice,
  type PaneLaunchAgentStoreSlice
} from './pane-launch-agent-candidate'

const PANE: PaneLaunchAgentPaneSlice = {
  worktreeId: 'wt-1',
  tabId: 'tab-1',
  paneKey: 'tab-1:leaf-1'
}

function store(overrides: Partial<PaneLaunchAgentStoreSlice> = {}): PaneLaunchAgentStoreSlice {
  return { tabsByWorktree: {}, agentLaunchConfigByPaneKey: {}, ...overrides }
}

describe('pane launch-agent candidate', () => {
  it('survives a launch config registered before its identity lands', () => {
    // Why: the OSC color-reply skip made this ladder run on EVERY pane connect, and
    // reading through a missing `identity` threw "Cannot read properties of undefined
    // (reading 'agentType')" — 24 failures across 8 connectPanePty suites.
    const state = store({ agentLaunchConfigByPaneKey: { 'tab-1:leaf-1': {} } })
    expect(resolvePaneLaunchAgentCandidate(state, PANE)).toBeUndefined()
    expect(resolvePaneLaunchTuiAgent(state, PANE)).toBeNull()
    expect(paneShouldAnswerOscColorQueries(state, PANE)).toBe(true)
  })

  it('prefers the tab launch agent over every later signal', () => {
    const state = store({ tabsByWorktree: { 'wt-1': [{ id: 'tab-1', launchAgent: 'jcode' }] } })
    const pane = { ...PANE, startup: { launchAgent: 'claude' } }
    expect(resolvePaneLaunchTuiAgent(state, pane)).toBe('jcode')
  })

  it('falls back through startup, then initial status, then the registered config', () => {
    expect(resolvePaneLaunchTuiAgent(store(), { ...PANE, startup: { launchAgent: 'jcode' } })).toBe(
      'jcode'
    )
    expect(
      resolvePaneLaunchTuiAgent(store(), {
        ...PANE,
        startup: { initialAgentStatus: { agent: 'jcode' } }
      })
    ).toBe('jcode')
    expect(
      resolvePaneLaunchTuiAgent(
        store({
          agentLaunchConfigByPaneKey: { 'tab-1:leaf-1': { identity: { agentType: 'jcode' } } }
        }),
        PANE
      )
    ).toBe('jcode')
  })

  it('ignores a registered agent name that is not a known TUI agent', () => {
    const state = store({
      agentLaunchConfigByPaneKey: { 'tab-1:leaf-1': { identity: { agentType: 'not-an-agent' } } }
    })
    expect(resolvePaneLaunchAgentCandidate(state, PANE)).toBeUndefined()
  })

  it('skips the OSC color answer for jcode and no one else', () => {
    for (const [launchAgent, answers] of [
      ['jcode', false],
      ['claude', true],
      ['codex', true],
      [undefined, true]
    ] as const) {
      const state = store({ tabsByWorktree: { 'wt-1': [{ id: 'tab-1', launchAgent }] } })
      expect(paneShouldAnswerOscColorQueries(state, PANE)).toBe(answers)
    }
  })
})
