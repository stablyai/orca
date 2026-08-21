import { describe, expect, it } from 'vitest'
import {
  isSideQuestAgent,
  resolveSideQuestAgent,
  sideQuestReadOnlyAgentArgs
} from './side-quest-agent'

describe('sideQuest agent selection', () => {
  it('supports only agents with native chat and an explicit read-only launch mode', () => {
    expect(isSideQuestAgent('claude')).toBe(true)
    expect(isSideQuestAgent('codex')).toBe(true)
    expect(isSideQuestAgent('grok')).toBe(false)
    expect(isSideQuestAgent(null)).toBe(false)
  })

  it('prefers the detected pane agent, then launch metadata, then the default', () => {
    expect(
      resolveSideQuestAgent({
        detectedAgent: 'codex',
        launchedAgent: 'claude',
        defaultAgent: 'claude',
        availableAgents: ['claude', 'codex']
      })
    ).toBe('codex')
    expect(
      resolveSideQuestAgent({
        launchedAgent: 'claude',
        defaultAgent: 'codex',
        availableAgents: ['claude', 'codex']
      })
    ).toBe('claude')
    expect(resolveSideQuestAgent({ defaultAgent: 'codex', availableAgents: ['codex'] })).toBe(
      'codex'
    )
  })

  it('returns null when no supported agent is available', () => {
    expect(resolveSideQuestAgent({ detectedAgent: 'grok', defaultAgent: 'blank' })).toBeNull()
  })

  it('does not use a disabled or host-unavailable default', () => {
    expect(
      resolveSideQuestAgent({
        defaultAgent: 'codex',
        availableAgents: ['codex'],
        disabledAgents: ['codex']
      })
    ).toBeNull()
    expect(resolveSideQuestAgent({ defaultAgent: 'codex', availableAgents: ['claude'] })).toBeNull()
  })
})

describe('sideQuestReadOnlyAgentArgs', () => {
  it('launches Claude in plan mode', () => {
    expect(sideQuestReadOnlyAgentArgs('claude')).toBe('--permission-mode plan')
  })

  it('launches Codex with a read-only sandbox and no escalation', () => {
    expect(sideQuestReadOnlyAgentArgs('codex')).toBe(
      '--sandbox read-only --ask-for-approval never -c model_reasoning_effort=low'
    )
  })
})
