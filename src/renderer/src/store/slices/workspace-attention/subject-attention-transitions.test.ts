import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { removeTabsAttention } from './subject-attention-transitions'

describe('removing a minted chat tab’s attention', () => {
  it('drops its completion marker, which its session address keys', () => {
    const tab = { id: 'chat-tab-a', entityId: 'chat-1', contentType: 'agent-session' } as Tab
    const key = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    const next = removeTabsAttention(
      {
        unreadTerminalTabs: { [tab.id]: 'agent-completion' },
        unreadTerminalPanes: {},
        unreadAgentCompletionPanes: { [key]: 'agent-completion' },
        unifiedTabsByWorktree: { ws: [tab] }
      },
      [tab.id]
    )
    expect(next.unreadAgentCompletionPanes).toEqual({})
    expect(next.unreadTerminalTabs).toEqual({})
  })
})
