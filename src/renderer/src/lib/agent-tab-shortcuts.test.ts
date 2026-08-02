import { describe, expect, it } from 'vitest'
import { listBoundAgentTabActions, resolveDefaultAgentForNewTab } from './agent-tab-shortcuts'

describe('listBoundAgentTabActions', () => {
  it('returns only agents whose per-agent action has a user-assigned chord', () => {
    expect(
      listBoundAgentTabActions(
        {
          'tab.newAgent.claude': ['Mod+Alt+Shift+C'],
          'tab.newAgent.codex': [],
          'tab.newTerminal': ['Mod+T']
        },
        []
      )
    ).toEqual([{ agent: 'claude', actionId: 'tab.newAgent.claude' }])
  })

  it('skips disabled agents even when their action is bound', () => {
    expect(
      listBoundAgentTabActions(
        {
          'tab.newAgent.claude': ['Mod+Alt+Shift+C'],
          'tab.newAgent.codex': ['Mod+Alt+Shift+X']
        },
        ['claude']
      )
    ).toEqual([{ agent: 'codex', actionId: 'tab.newAgent.codex' }])
  })

  it('returns nothing without overrides', () => {
    expect(listBoundAgentTabActions(undefined, [])).toEqual([])
    expect(listBoundAgentTabActions({}, null)).toEqual([])
  })
})

describe('resolveDefaultAgentForNewTab', () => {
  it('prefers the configured default agent when detected and enabled', () => {
    expect(
      resolveDefaultAgentForNewTab({
        defaultTuiAgent: 'codex',
        detectedAgentIds: ['claude', 'codex'],
        disabledTuiAgents: []
      })
    ).toBe('codex')
  })

  it('falls back to the auto-pick order when the default is blank', () => {
    // Why: 'blank' configures agent-less new workspaces, but an explicit
    // new-agent-tab chord still wants an agent.
    expect(
      resolveDefaultAgentForNewTab({
        defaultTuiAgent: 'blank',
        detectedAgentIds: ['codex', 'claude'],
        disabledTuiAgents: []
      })
    ).toBe('claude')
  })

  it('skips disabled agents and returns null when nothing is launchable', () => {
    expect(
      resolveDefaultAgentForNewTab({
        defaultTuiAgent: 'claude',
        detectedAgentIds: ['claude'],
        disabledTuiAgents: ['claude']
      })
    ).toBeNull()
    expect(
      resolveDefaultAgentForNewTab({
        defaultTuiAgent: null,
        detectedAgentIds: null,
        disabledTuiAgents: []
      })
    ).toBeNull()
  })
})
