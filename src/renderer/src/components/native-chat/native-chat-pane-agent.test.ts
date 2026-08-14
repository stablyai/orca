import { describe, expect, it } from 'vitest'
import {
  createTerminalTabNativeChatPaneEvidenceSelector,
  resolveNativeChatPaneAgent
} from './native-chat-pane-agent'

describe('resolveNativeChatPaneAgent', () => {
  it('admits the pane launch identity before the first hook', () => {
    expect(resolveNativeChatPaneAgent({ paneLaunchAgent: 'codex' })).toBe('codex')
  })

  it('prefers current hook and process identity over launch metadata', () => {
    expect(
      resolveNativeChatPaneAgent({
        hookAgent: 'claude',
        foreground: { agent: 'codex', shellForeground: false },
        paneLaunchAgent: 'grok'
      })
    ).toBe('claude')
    expect(
      resolveNativeChatPaneAgent({
        foreground: { agent: 'codex', shellForeground: false },
        paneLaunchAgent: 'grok'
      })
    ).toBe('codex')
  })

  it('rejects stale launch metadata after process exit evidence', () => {
    expect(
      resolveNativeChatPaneAgent({
        foreground: { agent: null, shellForeground: true },
        paneLaunchAgent: 'codex'
      })
    ).toBeNull()
    expect(
      resolveNativeChatPaneAgent({
        foreground: { agent: null, routingRevoked: true, shellForeground: false },
        paneLaunchAgent: 'codex'
      })
    ).toBeNull()
  })
})

describe('createTerminalTabNativeChatPaneEvidenceSelector', () => {
  it('keeps launch and foreground evidence scoped to each split leaf', () => {
    const select = createTerminalTabNativeChatPaneEvidenceSelector()
    const launchConfigs = {
      'tab-1:leaf-a': { identity: { agentType: 'codex' as const } },
      'tab-1:leaf-b': { identity: { agentType: 'gemini' as const } },
      'tab-2:leaf-c': { identity: { agentType: 'claude' as const } }
    }
    const foregroundAgents = {
      'tab-1:leaf-b': { agent: 'gemini' as const, shellForeground: false }
    }

    expect(select(launchConfigs, foregroundAgents, 'tab-1')).toEqual({
      'leaf-a': { paneLaunchAgent: 'codex' },
      'leaf-b': {
        paneLaunchAgent: 'gemini',
        foreground: foregroundAgents['tab-1:leaf-b']
      }
    })
    expect(select(launchConfigs, foregroundAgents, 'tab-2')).toEqual({
      'leaf-c': { paneLaunchAgent: 'claude' }
    })
  })

  it('reuses per-tab projections when unrelated pane maps change', () => {
    const select = createTerminalTabNativeChatPaneEvidenceSelector()
    const firstLaunchConfigs = {
      'tab-1:leaf-a': { identity: { agentType: 'codex' as const } }
    }
    const first = select(firstLaunchConfigs, {}, 'tab-1')
    const nextLaunchConfigs = {
      ...firstLaunchConfigs,
      'tab-2:leaf-b': { identity: { agentType: 'claude' as const } }
    }

    expect(select(nextLaunchConfigs, {}, 'tab-1')).toBe(first)
  })
})
