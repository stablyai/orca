import { describe, expect, it } from 'vitest'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'
import type { CustomTuiAgentId } from '../../../shared/types'
import { AGENT_CATALOG } from './agent-catalog'
import {
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from './quick-workspace-agent-selection'

describe('pickQuickWorkspaceAgent', () => {
  it('keeps the fallback order in sync with the desktop agent catalog', () => {
    expect(TUI_AGENT_AUTO_PICK_ORDER).toEqual(AGENT_CATALOG.map((agent) => agent.id))
    expect(new Set(TUI_AGENT_AUTO_PICK_ORDER).size).toBe(TUI_AGENT_AUTO_PICK_ORDER.length)
  })

  it('uses the first enabled catalog agent while detection is pending', () => {
    expect(pickQuickWorkspaceAgent(null, null, [])).toBe('claude')
    expect(pickQuickWorkspaceAgent(null, null, ['claude'])).toBe('claude-agent-teams')
    expect(pickQuickWorkspaceAgent(null, null, ['claude', 'claude-agent-teams'])).toBe('openclaude')
    expect(
      pickQuickWorkspaceAgent(null, null, ['claude', 'claude-agent-teams', 'openclaude'])
    ).toBe('codex')
  })

  it('respects blank and disabled preferred agents', () => {
    expect(pickQuickWorkspaceAgent('blank', null, [])).toBeNull()
    expect(pickQuickWorkspaceAgent('codex', null, ['codex'])).toBe('claude')
  })

  it('uses detected enabled agents after detection resolves', () => {
    expect(pickQuickWorkspaceAgent(null, ['codex'], ['claude'])).toBe('codex')
    expect(pickQuickWorkspaceAgent('codex', ['claude', 'codex'], ['codex'])).toBe('claude')
  })

  it('uses a selectable custom agent when it is the saved preference', () => {
    const customCodex =
      'custom-agent:codex:11111111-1111-4111-8111-111111111111' as CustomTuiAgentId
    expect(pickQuickWorkspaceAgent(customCodex, ['claude', customCodex], [])).toBe(customCodex)
  })
})

describe('resolveQuickWorkspaceAgentSelection', () => {
  const customCodex = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as CustomTuiAgentId

  it('uses the preferred quick agent until the user picks an override', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: undefined,
        preferredQuickAgent: 'claude',
        selectableAgentIds: ['claude', 'codex']
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: undefined })
  })

  it('keeps explicit blank overrides stable', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: null,
        preferredQuickAgent: 'claude',
        selectableAgentIds: ['claude']
      })
    ).toEqual({ quickAgent: null, quickAgentOverride: null })
  })

  it('keeps an available user override', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'codex',
        preferredQuickAgent: 'claude',
        selectableAgentIds: new Set(['claude', 'codex'])
      })
    ).toEqual({ quickAgent: 'codex', quickAgentOverride: 'codex' })
  })

  it('keeps a custom override present in the picker option set', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: customCodex,
        preferredQuickAgent: 'claude',
        selectableAgentIds: new Set(['claude', customCodex])
      })
    ).toEqual({ quickAgent: customCodex, quickAgentOverride: customCodex })
  })

  it('replaces a custom override removed from the picker option set', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: customCodex,
        preferredQuickAgent: 'claude',
        selectableAgentIds: new Set(['claude', 'codex'])
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: 'claude' })
  })

  it('replaces an unavailable override with the preferred quick agent', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'codex',
        preferredQuickAgent: 'claude',
        selectableAgentIds: ['claude']
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: 'claude' })
  })
})
