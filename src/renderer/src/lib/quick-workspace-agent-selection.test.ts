import { describe, expect, it } from 'vitest'

import {
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from './quick-workspace-agent-selection'

describe('resolveQuickWorkspaceAgentSelection', () => {
  it('uses the preferred quick agent until the user picks an override', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: undefined,
        preferredQuickAgent: 'claude',
        detectedAgentIds: ['claude', 'codex'],
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: undefined })
  })

  it('keeps explicit blank overrides stable', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: null,
        preferredQuickAgent: 'claude',
        detectedAgentIds: ['claude'],
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: null, quickAgentOverride: null })
  })

  it('keeps an available user override', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'codex',
        preferredQuickAgent: 'claude',
        detectedAgentIds: new Set(['claude', 'codex']),
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: 'codex', quickAgentOverride: 'codex' })
  })

  it('clears an unavailable override so the preferred default still receives host preflight', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'codex',
        preferredQuickAgent: 'claude',
        detectedAgentIds: ['claude'],
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: undefined })
  })
})

it('keeps an explicit or default pick of a chat without its CLI; the automatic pick stays on detected agents', () => {
  const offered = new Set(['claude', 'antigravity'] as const)
  expect(pickQuickWorkspaceAgent('antigravity', ['claude'], [], offered)).toBe('antigravity')
  expect(pickQuickWorkspaceAgent(null, [], [], offered)).toBeNull()
})
