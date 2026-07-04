import { describe, expect, it } from 'vitest'
import {
  isNativeChatShortcutTitleFallbackSafe,
  resolveNativeChatToggleShortcutDetectedAgent
} from './use-native-chat-toggle-shortcut'

describe('resolveNativeChatToggleShortcutDetectedAgent', () => {
  it('uses the active split leaf instead of the first tab agent entry', () => {
    expect(
      resolveNativeChatToggleShortcutDetectedAgent({
        terminalTabId: 'tab-1',
        activeLeafId: 'leaf-2',
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
        activeLeafId: 'leaf-2',
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
        activeLeafId: null,
        agentStatusByPaneKey: {
          'tab-2:leaf-1': { agentType: 'codex' },
          'tab-1:leaf-1': { agentType: 'claude' }
        }
      })
    ).toBe('claude')
  })
})

describe('isNativeChatShortcutTitleFallbackSafe', () => {
  it('allows title fallback before a layout snapshot exists', () => {
    expect(isNativeChatShortcutTitleFallbackSafe(null)).toBe(true)
  })

  it('allows title fallback for a single leaf layout', () => {
    expect(isNativeChatShortcutTitleFallbackSafe({ type: 'leaf', leafId: 'leaf-1' })).toBe(true)
  })

  it('rejects title fallback for split layouts', () => {
    expect(
      isNativeChatShortcutTitleFallbackSafe({
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-1' },
        second: { type: 'leaf', leafId: 'leaf-2' }
      })
    ).toBe(false)
  })
})
