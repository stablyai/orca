import { describe, expect, it } from 'vitest'
import { isNativeChatTabWideFallbackSafe } from './native-chat-leaf-routing'
import { resolveNativeChatToggleShortcutDetectedAgent } from './use-native-chat-toggle-shortcut'

const splitLayout = {
  root: {
    type: 'split' as const,
    direction: 'horizontal' as const,
    first: { type: 'leaf' as const, leafId: 'leaf-1' },
    second: { type: 'leaf' as const, leafId: 'leaf-2' }
  },
  activeLeafId: 'leaf-2',
  expandedLeafId: null
}

describe('resolveNativeChatToggleShortcutDetectedAgent', () => {
  it('uses the active split leaf instead of the first tab agent entry', () => {
    expect(
      resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: 'tab-1',
        terminalLayout: splitLayout,
        agentStatusByPaneKey: {
          'tab-1:leaf-1': { agentType: 'gemini' },
          'tab-1:leaf-2': { agentType: 'codex' }
        }
      })
    ).toBe('codex')
  })

  it('keeps an unsupported active leaf authoritative over a supported sibling', () => {
    expect(
      resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: 'tab-1',
        terminalLayout: splitLayout,
        agentStatusByPaneKey: {
          'tab-1:leaf-1': { agentType: 'claude' },
          'tab-1:leaf-2': { agentType: 'grok' }
        }
      })
    ).toBe('grok')
  })

  it('falls back to the tab entry before a leaf is known', () => {
    expect(
      resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: 'tab-1',
        agentStatusByPaneKey: {
          'tab-2:leaf-1': { agentType: 'codex' },
          'tab-1:leaf-1': { agentType: 'claude' }
        }
      })
    ).toBe('claude')
  })

  it('does not inherit a split sibling before the active leaf is known', () => {
    expect(
      resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: 'tab-1',
        terminalLayout: { ...splitLayout, activeLeafId: null },
        agentStatusByPaneKey: {
          'tab-1:agent-leaf': { agentType: 'claude' },
          'tab-1:shell-leaf': {}
        }
      })
    ).toBeNull()
  })

  it('uses the sole layout leaf when activeLeafId has not hydrated yet', () => {
    expect(
      resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: 'tab-1',
        terminalLayout: {
          root: { type: 'leaf', leafId: 'leaf-2' },
          activeLeafId: null,
          expandedLeafId: null
        },
        agentStatusByPaneKey: {
          'tab-1:closed-leaf': { agentType: 'claude' },
          'tab-1:leaf-2': { agentType: 'codex' }
        }
      })
    ).toBe('codex')
  })

  it('rejects a stale active leaf instead of reading its retained status', () => {
    expect(
      resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: 'tab-1',
        terminalLayout: {
          root: { type: 'leaf', leafId: 'leaf-2' },
          activeLeafId: 'closed-leaf',
          expandedLeafId: null
        },
        agentStatusByPaneKey: {
          'tab-1:closed-leaf': { agentType: 'claude' },
          'tab-1:leaf-2': { agentType: 'codex' }
        }
      })
    ).toBeNull()
  })
})

describe('isNativeChatTabWideFallbackSafe', () => {
  it('allows title fallback before a layout snapshot exists', () => {
    expect(isNativeChatTabWideFallbackSafe(null)).toBe(true)
  })

  it('allows title fallback for a single leaf layout', () => {
    expect(
      isNativeChatTabWideFallbackSafe({
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      })
    ).toBe(true)
  })

  it('rejects title fallback for split layouts', () => {
    expect(isNativeChatTabWideFallbackSafe(splitLayout)).toBe(false)
  })

  it('rejects title fallback while a collapsed layout still has a stale active id', () => {
    expect(
      isNativeChatTabWideFallbackSafe({
        root: { type: 'leaf', leafId: 'leaf-2' },
        activeLeafId: 'closed-leaf',
        expandedLeafId: null
      })
    ).toBe(false)
  })
})
