import { describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { workspaceMarkerPaneKeysForHost } from './workspace-marker-host'

describe('a minted chat tab’s markers', () => {
  it('are found by the session address its pane keys carry, so marking read clears them', () => {
    const tab = { id: 'chat-tab-a', entityId: 'chat-1', contentType: 'agent-session' }
    const state = {
      tabsByWorktree: {},
      unifiedTabsByWorktree: { ws: [tab] }
    } as unknown as AppState
    const key = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    expect(key.startsWith('structured-agent-session-chat-1:')).toBe(true)
    expect([...workspaceMarkerPaneKeysForHost(state, 'ws', undefined, [key])]).toEqual([key])
  })
})
