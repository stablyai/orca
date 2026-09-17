import { describe, expect, it } from 'vitest'
import { ALL_TUI_AGENTS } from './tui-agent-display-names'
import {
  AGENT_READINESS_CAPABILITIES,
  getAgentReadinessCapability,
  supportsAgentPromptTurnStart
} from './agent-readiness-capabilities'

describe('agent readiness capability matrix', () => {
  it('covers every launchable provider exactly once', () => {
    expect(Object.keys(AGENT_READINESS_CAPABILITIES).sort()).toEqual([...ALL_TUI_AGENTS].sort())
    for (const capability of Object.values(AGENT_READINESS_CAPABILITIES)) {
      expect(capability.terminal.terminalReconciliation).toBeTruthy()
      expect(capability.structured.terminalReconciliation).toBeTruthy()
    }
  })

  it('keeps structured sessions limited to their acknowledged provider API', () => {
    expect(getAgentReadinessCapability('claude', 'structured')).toMatchObject({
      readiness: 'supported',
      submission: 'native-session',
      receipt: 'turn-start',
      terminalReconciliation: 'native-session'
    })
    expect(getAgentReadinessCapability('codex', 'structured')).toMatchObject({
      readiness: 'supported',
      submission: 'native-session',
      receipt: 'turn-start',
      terminalReconciliation: 'native-session'
    })
    expect(getAgentReadinessCapability('aider', 'structured')).toMatchObject({
      readiness: 'unsupported',
      submission: 'native-session',
      receipt: 'input-accepted',
      terminalReconciliation: 'unsupported'
    })
  })

  it('does not treat Antigravity captures as a complete readiness contract', () => {
    expect(getAgentReadinessCapability('antigravity', 'terminal')).toMatchObject({
      readiness: 'unsupported',
      evidence: [],
      receipt: 'input-accepted',
      terminalReconciliation: 'pty-incarnation'
    })
  })

  it('identifies the only terminal providers with correlated turn-start receipts', () => {
    expect(supportsAgentPromptTurnStart('claude')).toBe(true)
    expect(supportsAgentPromptTurnStart('codex')).toBe(true)
    expect(supportsAgentPromptTurnStart('kimi')).toBe(false)
    expect(supportsAgentPromptTurnStart(undefined)).toBe(false)
  })
})
