import { describe, expect, it } from 'vitest'
import { structuredAgentSessionPaneKey } from '../../../../../shared/structured-agent-session-projection'
import { workspaceHasLiveMarker } from './workspace-live-markers'

const WORKSPACE = 'wt-1'
const LEAF = '11111111-1111-4111-8111-111111111111'

const terminal = { tabsByWorktree: { [WORKSPACE]: [{ id: 'tab-1' }] } }
const chat = (sessionId: string) => ({
  unifiedTabsByWorktree: {
    [WORKSPACE]: [{ id: 'chat-tab', contentType: 'agent-session' as const, entityId: sessionId }]
  }
})

describe('workspaceHasLiveMarker', () => {
  it('counts tab and completion markers on this workspace’s terminal tabs only', () => {
    expect(
      workspaceHasLiveMarker(
        {
          ...terminal,
          unreadTerminalTabs: { 'tab-1': 'terminal-bell' },
          unreadAgentCompletionPanes: {}
        },
        WORKSPACE
      )
    ).toBe(true)
    expect(
      workspaceHasLiveMarker(
        { ...terminal, unreadAgentCompletionPanes: { [`tab-1:${LEAF}`]: 'agent-completion' } },
        WORKSPACE
      )
    ).toBe(true)
    expect(
      workspaceHasLiveMarker(
        {
          ...terminal,
          unreadTerminalTabs: { 'tab-elsewhere': 'terminal-bell' },
          unreadAgentCompletionPanes: { [`tab-elsewhere:${LEAF}`]: 'agent-completion' }
        },
        WORKSPACE
      )
    ).toBe(false)
  })

  it('counts a structured chat’s completion only under its current session', () => {
    const current = structuredAgentSessionPaneKey('chat-tab', 'session-1')
    expect(
      workspaceHasLiveMarker(
        { ...chat('session-1'), unreadAgentCompletionPanes: { [current]: 'agent-completion' } },
        WORKSPACE
      )
    ).toBe(true)
    expect(
      workspaceHasLiveMarker(
        { ...chat('session-2'), unreadAgentCompletionPanes: { [current]: 'agent-completion' } },
        WORKSPACE
      )
    ).toBe(false)
  })

  it('a workspace with no tabs holds nothing', () => {
    expect(
      workspaceHasLiveMarker(
        { unreadTerminalTabs: { 'tab-1': 'terminal-bell' }, unreadAgentCompletionPanes: {} },
        WORKSPACE
      )
    ).toBe(false)
  })
})
