import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { findTabAgentEntry } from '../native-chat/native-chat-tab-agent-entry'
import {
  selectNativeChatTabWideFallbackUnsafeTabsById,
  selectTabAgentTypesByTabId
} from './tab-agent-types-by-tab-id'

function entry(partial: Partial<AgentStatusEntry>): AgentStatusEntry {
  return { state: 'working', updatedAt: 0, ...partial } as AgentStatusEntry
}

function splitLayout(activeLeafId: string | null): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    },
    activeLeafId,
    expandedLeafId: null
  }
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

  it('uses the active split leaf regardless of pane-map insertion order', () => {
    const layouts = { 'tab-1': splitLayout('leaf-b') }
    const agentFirst = {
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-1:leaf-b': entry({ agentType: 'codex' })
    }
    const activeFirst = {
      'tab-1:leaf-b': entry({ agentType: 'codex' }),
      'tab-1:leaf-a': entry({ agentType: 'claude' })
    }

    expect(selectTabAgentTypesByTabId(agentFirst, layouts)['tab-1']).toBe('codex')
    expect(selectTabAgentTypesByTabId(activeFirst, layouts)['tab-1']).toBe('codex')
    expect(selectNativeChatTabWideFallbackUnsafeTabsById(layouts)).toEqual({ 'tab-1': true })
  })

  it('does not inherit a supported sibling when the active split leaf is a shell', () => {
    const projection = selectTabAgentTypesByTabId(
      {
        'tab-1:leaf-a': entry({ agentType: 'claude' }),
        'tab-1:leaf-b': entry({ agentType: undefined })
      },
      { 'tab-1': splitLayout('leaf-b') }
    )

    expect(projection['tab-1'] ?? null).toBeNull()
  })

  it('uses the reassigned active sibling after the prior agent leaf closes', () => {
    const statuses = {
      'tab-1:leaf-a': entry({ agentType: 'claude' }),
      'tab-1:leaf-b': entry({ agentType: 'codex' })
    }

    expect(
      selectTabAgentTypesByTabId(statuses, {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-b' },
          activeLeafId: 'leaf-b',
          expandedLeafId: null
        }
      })['tab-1']
    ).toBe('codex')
  })

  it('does not fall back to insertion order while a split has no active leaf', () => {
    const projection = selectTabAgentTypesByTabId(
      {
        'tab-1:leaf-a': entry({ agentType: 'claude' }),
        'tab-1:leaf-b': entry({ agentType: undefined })
      },
      { 'tab-1': splitLayout(null) }
    )

    expect(projection['tab-1'] ?? null).toBeNull()
  })

  it('ignores a stale active leaf id that is no longer in the layout', () => {
    const projection = selectTabAgentTypesByTabId(
      {
        'tab-1:closed-leaf': entry({ agentType: 'claude' }),
        'tab-1:leaf-a': entry({ agentType: undefined })
      },
      {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'closed-leaf',
          expandedLeafId: null
        }
      }
    )

    expect(projection['tab-1'] ?? null).toBeNull()
    expect(
      selectNativeChatTabWideFallbackUnsafeTabsById({
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'closed-leaf',
          expandedLeafId: null
        }
      })
    ).toEqual({ 'tab-1': true })
  })

  it('uses the pane entry while a rootless layout is still hydrating', () => {
    expect(
      selectTabAgentTypesByTabId(
        { 'tab-1:leaf-a': entry({ agentType: 'claude' }) },
        { 'tab-1': { root: null, activeLeafId: null, expandedLeafId: null } }
      )
    ).toEqual({ 'tab-1': 'claude' })
  })

  it('treats a missing layout map as no unsafe split evidence during hydration', () => {
    expect(selectNativeChatTabWideFallbackUnsafeTabsById()).toEqual({})
  })

  it('resolves the active leaf through nested splits and ignores expanded siblings', () => {
    const layout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-b' },
          second: { type: 'leaf', leafId: 'leaf-c' }
        }
      },
      activeLeafId: 'leaf-c',
      expandedLeafId: 'leaf-a'
    }

    expect(
      selectTabAgentTypesByTabId(
        {
          'tab-1:leaf-a': entry({ agentType: 'claude' }),
          'tab-1:leaf-c': entry({ agentType: 'codex' })
        },
        { 'tab-1': layout }
      )
    ).toEqual({ 'tab-1': 'codex' })
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
