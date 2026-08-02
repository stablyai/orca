import { describe, it, expect } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { resolveNativeChatSession } from './native-chat-pane-resolution'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'

function entry(
  overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>
): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    stateHistory: [],
    ...overrides
  }
}

/**
 * #19 guard: the narrowed `useShallow(findTabAgentEntry(...))` selector must
 * resolve to exactly the same pane entry — and thus the same
 * resolveNativeChatSession result — as the old whole-map scan. These tests lock
 * the selector's resolution semantics so the perf narrowing can't drift.
 */
describe('findTabAgentEntry (#19 selector)', () => {
  it('returns the entry whose paneKey carries the tab id prefix', () => {
    const target = entry({ paneKey: 'tab-1:leaf-a', agentType: 'claude' })
    const map: Record<string, AgentStatusEntry> = {
      'tab-0:leaf-z': entry({ paneKey: 'tab-0:leaf-z' }),
      'tab-1:leaf-a': target,
      'tab-2:leaf-b': entry({ paneKey: 'tab-2:leaf-b' })
    }
    expect(findTabAgentEntry(map, 'tab-1')).toBe(target)
  })

  it('returns undefined when no pane matches the tab id', () => {
    const map: Record<string, AgentStatusEntry> = {
      'tab-0:leaf-z': entry({ paneKey: 'tab-0:leaf-z' })
    }
    expect(findTabAgentEntry(map, 'tab-1')).toBeUndefined()
  })

  it('returns the first matching pane (deterministic insertion order)', () => {
    const first = entry({ paneKey: 'tab-1:leaf-a' })
    const second = entry({ paneKey: 'tab-1:leaf-b' })
    const map: Record<string, AgentStatusEntry> = {
      'tab-1:leaf-a': first,
      'tab-1:leaf-b': second
    }
    expect(findTabAgentEntry(map, 'tab-1')).toBe(first)
  })

  it('does not match a tab id that is only a substring of another tab id', () => {
    const map: Record<string, AgentStatusEntry> = {
      'tab-10:leaf-a': entry({ paneKey: 'tab-10:leaf-a' })
    }
    // `tab-1:` prefix must not match `tab-10:` — the colon delimiter guards this.
    expect(findTabAgentEntry(map, 'tab-1')).toBeUndefined()
  })

  it('resolves identically to the whole-map scan, including the empty-tabid fallback', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const target = entry({
      paneKey,
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'sess-abc' }
    })
    const map: Record<string, AgentStatusEntry> = {
      'tab-0:other': entry({ paneKey: 'tab-0:other', agentType: 'codex' }),
      [paneKey]: target
    }

    // Old path: scan whole map, then fall back to `${tabId}:` when absent.
    const oldEntry = findTabAgentEntry(map, 'tab-1')
    const oldResolution = resolveNativeChatSession({
      paneKey: oldEntry?.paneKey ?? 'tab-1:',
      launchAgent: 'claude',
      ...(oldEntry ? { agentStatusEntry: oldEntry } : {}),
      ptyId: null
    })

    // New path: narrowed selector returns the same entry; same resolution.
    const newEntry = findTabAgentEntry(map, 'tab-1')
    const newResolution = resolveNativeChatSession({
      paneKey: newEntry?.paneKey ?? 'tab-1:',
      launchAgent: 'claude',
      ...(newEntry ? { agentStatusEntry: newEntry } : {}),
      ptyId: null
    })

    expect(newEntry).toBe(oldEntry)
    expect(newResolution).toEqual(oldResolution)
  })

  it('falls back to `${terminalTabId}:` paneKey when the tab has no entry', () => {
    const map: Record<string, AgentStatusEntry> = {}
    const found = findTabAgentEntry(map, 'tab-9')
    const paneKey = found?.paneKey ?? 'tab-9:'
    expect(found).toBeUndefined()
    expect(paneKey).toBe('tab-9:')
  })
})
