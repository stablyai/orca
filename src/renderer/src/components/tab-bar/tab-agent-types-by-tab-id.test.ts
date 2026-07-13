import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { findTabAgentEntry } from '../native-chat/native-chat-tab-agent-entry'
import { selectTabAgentTypesByTabId } from './tab-agent-types-by-tab-id'

function entry(partial: Partial<AgentStatusEntry>): AgentStatusEntry {
  return { state: 'working', updatedAt: 0, ...partial } as AgentStatusEntry
}

describe('selectTabAgentTypesByTabId', () => {
  it('maps each tab to its first pane agent type, matching findTabAgentEntry', () => {
    const map: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-1:leaf-b': entry({ agentType: 'codex' }),
      'tab-2:leaf-a': entry({ agentType: 'codex' })
    }
    const projection = selectTabAgentTypesByTabId(map)
    expect(projection).toEqual({ 'tab-1': 'claude', 'tab-2': 'codex' })

    // Parity with the lookup it replaces, for every tab.
    for (const tabId of ['tab-1', 'tab-2', 'tab-missing']) {
      expect(projection[tabId] ?? null).toBe(findTabAgentEntry(map, tabId)?.agentType ?? null)
    }
  })

  it('a first pane without an agentType yields null even if a later pane has one', () => {
    const map: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': entry({ agentType: undefined }),
      'tab-1:leaf-b': entry({ agentType: 'claude' })
    }
    // First matching pane wins (claims the tab) with no agentType -> null, exactly
    // like findTabAgentEntry(...)?.agentType ?? null.
    expect(selectTabAgentTypesByTabId(map)['tab-1'] ?? null).toBe(
      findTabAgentEntry(map, 'tab-1')?.agentType ?? null
    )
  })

  it('stays shallow-equal across a working<->idle status flip (no re-render)', () => {
    const working: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': entry({ agentType: 'claude', state: 'working' })
    }
    // A status write replaces the entry object but not the agentType.
    const done: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': entry({ agentType: 'claude', state: 'done' })
    }
    expect(shallow(selectTabAgentTypesByTabId(working), selectTabAgentTypesByTabId(done))).toBe(
      true
    )
  })

  it('shallow-changes when a tab gains or changes its agent', () => {
    const before = selectTabAgentTypesByTabId({
      'tab-1:leaf-a': entry({ agentType: 'claude' })
    })
    const gained = selectTabAgentTypesByTabId({
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-2:leaf-a': entry({ agentType: 'codex' })
    })
    expect(shallow(before, gained)).toBe(false)
  })

  it('ignores malformed pane keys with no tab id', () => {
    expect(selectTabAgentTypesByTabId({ ':leaf-a': entry({ agentType: 'claude' }) })).toEqual({})
  })
})
