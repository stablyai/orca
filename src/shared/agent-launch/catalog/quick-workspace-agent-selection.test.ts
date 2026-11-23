import { expect, it } from 'vitest'
import { resolveQuickWorkspaceAgentSelection } from './quick-workspace-agent-selection'

it('keeps an invalidated pick implicit so later target defaults still apply', () => {
  const repaired = resolveQuickWorkspaceAgentSelection({
    quickAgentOverride: 'claude',
    preferredQuickAgent: 'codex',
    detectedAgentIds: ['codex'],
    disabledTuiAgents: ['claude']
  })
  expect(repaired).toEqual({ quickAgent: 'codex', quickAgentOverride: undefined })
  expect(
    resolveQuickWorkspaceAgentSelection({
      quickAgentOverride: repaired.quickAgentOverride,
      preferredQuickAgent: 'gemini',
      detectedAgentIds: ['gemini']
    })
  ).toEqual({ quickAgent: 'gemini', quickAgentOverride: undefined })
})
