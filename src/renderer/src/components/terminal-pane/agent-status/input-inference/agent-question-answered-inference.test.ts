import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { createAgentQuestionAnsweredInference } from './agent-question-answered-inference'

const NOW = 1_000_000

function observe(entry: Partial<AgentStatusEntry>, data: string): boolean {
  const inferQuestionAnswered = vi.fn()
  const status: AgentStatusEntry = {
    state: 'waiting',
    prompt: 'p',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey: 'tab-1:pane',
    stateHistory: [],
    ...entry
  }
  createAgentQuestionAnsweredInference({
    paneKey: 'tab-1:pane',
    getStatusEntry: () => status,
    inferQuestionAnswered,
    now: () => NOW
  }).observeSentTerminalInput(data)
  return inferQuestionAnswered.mock.calls.length > 0
}

const codexAsync = {
  agentType: 'codex',
  toolName: 'request_user_input_async'
} as const

describe('Codex async question skip', () => {
  it.each(['\x1d', '\x1b[93;5u'])('infers a skip from Ctrl+] (%j)', (data) => {
    expect(observe(codexAsync, data)).toBe(true)
  })

  it('ignores Enter, which Codex reports through a reply hook', () => {
    expect(observe(codexAsync, '\r')).toBe(false)
  })

  it('ignores Ctrl+] for other rows', () => {
    expect(observe({ agentType: 'claude', toolName: 'AskUserQuestion' }, '\x1d')).toBe(false)
    expect(observe({ ...codexAsync, state: 'working' }, '\x1d')).toBe(false)
  })
})
