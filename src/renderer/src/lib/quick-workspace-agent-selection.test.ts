import { describe, expect, it } from 'vitest'

import {
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from './quick-workspace-agent-selection'

describe('resolveQuickWorkspaceAgentSelection', () => {
  it('replaces an unavailable override with the preferred quick agent', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'codex',
        preferredQuickAgent: 'claude',
        detectedAgentIds: ['claude'],
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: 'claude' })
  })
})

it('keeps an explicit or default pick of a chat without its CLI; the automatic pick stays on detected agents', () => {
  const offered = new Set(['claude', 'antigravity'] as const)
  expect(pickQuickWorkspaceAgent('antigravity', ['claude'], [], offered)).toBe('antigravity')
  expect(pickQuickWorkspaceAgent(null, [], [], offered)).toBeNull()
})
