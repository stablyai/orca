import { describe, expect, it } from 'vitest'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../../../../shared/command-token-scanner'
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
  it('keeps command-only pane inference bounded for large pasted scripts', () => {
    const command = `sleep 30 && claude '${'x'.repeat(COMMAND_TOKEN_SCAN_MAX_CHARS)}'`
    expect(resolvePaneLaunchTuiAgent(store(), { ...PANE, startup: { command } })).toBeNull()
    expect(
      resolvePaneLaunchTuiAgent(store(), { ...PANE, startup: { command, launchAgent: 'claude' } })
    ).toBe('claude')
  })

  it.each(['jcode', 'sleep 30 && jcode'])(
    'skips jcode colors for command-only startup %s',
    (command) => {
      const pane = { ...PANE, startup: { command } }
      expect(resolvePaneLaunchTuiAgent(store(), pane)).toBe('jcode')
      expect(paneShouldAnswerOscColorQueries(store(), pane)).toBe(false)
    }
  )

  it('keeps explicit pane ownership ahead of a delayed command hint', () => {
    const pane = { ...PANE, startup: { command: 'sleep 30 && jcode', launchAgent: 'claude' } }
    expect(resolvePaneLaunchTuiAgent(store(), pane)).toBe('claude')
    expect(paneShouldAnswerOscColorQueries(store(), pane)).toBe(true)
  })

  it.each(['echo "sleep 30 && jcode"', 'sleep 30 && claude -p task'])(
    'does not infer a TUI from %s',
    (command) => {
      expect(resolvePaneLaunchTuiAgent(store(), { ...PANE, startup: { command } })).toBeNull()
    }
  )

  it('survives a launch config registered before its identity lands', () => {
    // Missing identity must be safe because color-reply classification runs this ladder for every pane connect.
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
