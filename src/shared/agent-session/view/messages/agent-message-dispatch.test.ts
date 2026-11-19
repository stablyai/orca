import { describe, expect, it } from 'vitest'
import { agentMessageSessionWorker } from './agent-message-dispatch'
import type { AgentMessageSource } from '../../journal/agent-session-message-source'
import type { OrchestrationSessionWorker } from '../../../orchestration-session-workers'
import { createOrcaSessionId, type OrcaSessionId } from '../../identity/orca-session-address'

const SESSION_B = createOrcaSessionId(() => '0b6c3a52-6a77-4d1e-9a2f-1f0f9d1f2b3c')

function worker(dispatchId: string, extra: Partial<OrchestrationSessionWorker> = {}) {
  return {
    dispatchId,
    taskId: 't',
    runId: 'r',
    title: dispatchId,
    agent: 'claude',
    state: 'working',
    liveness: 'live',
    host: 'local',
    worktreeId: null,
    paneKey: null,
    chatSessionId: null,
    startedAt: 0,
    settledAt: null,
    ...extra
  } satisfies OrchestrationSessionWorker
}

function mailFrom(...addresses: [string, OrcaSessionId | null][]): AgentMessageSource {
  return {
    kind: 'agent',
    orchestration: null,
    senders: addresses.map(([address, orcaSessionId]) => ({
      party: { address, terminalHandle: null, orcaSessionId },
      name: null
    }))
  }
}

const workers = [
  worker('ctx_a', { address: 'term_a' }),
  worker('ctx_b', { chatSessionId: SESSION_B }),
  worker('ctx_c')
]

describe('agentMessageSessionWorker', () => {
  it('reads a start by its Dispatch id', () => {
    expect(agentMessageSessionWorker({ agentStartDispatchId: 'ctx_c' }, workers)?.dispatchId).toBe(
      'ctx_c'
    )
  })

  it('matches mail by the worker address, chat session or federated Dispatch address', () => {
    expect(
      agentMessageSessionWorker({ from: mailFrom(['term_a', null]) }, workers)?.dispatchId
    ).toBe('ctx_a')
    expect(
      agentMessageSessionWorker({ from: mailFrom(['chat-handle', SESSION_B]) }, workers)?.dispatchId
    ).toBe('ctx_b')
    expect(
      agentMessageSessionWorker({ from: mailFrom(['dispatch:ctx_c', null]) }, workers)?.dispatchId
    ).toBe('ctx_c')
  })

  it('answers nothing for mail from two workers or from someone else', () => {
    expect(
      agentMessageSessionWorker(
        { from: mailFrom(['term_a', null], ['dispatch:ctx_c', null]) },
        workers
      )
    ).toBeUndefined()
    expect(agentMessageSessionWorker({ from: mailFrom(['term_z', null]) }, workers)).toBeUndefined()
  })

  it('gives mail from a reused worker terminal to the Dispatch it had most recently started', () => {
    const reused = [
      worker('ctx_new', { address: 'term_x', startedAt: 300 }),
      worker('ctx_old', { address: 'term_x', state: 'failed', startedAt: 100, settledAt: 200 })
    ]
    const sentAt = (timestamp: number) =>
      agentMessageSessionWorker({ from: mailFrom(['term_x', null]), timestamp }, reused)?.dispatchId
    expect(sentAt(150)).toBe('ctx_old')
    expect(sentAt(200)).toBe('ctx_old')
    expect(sentAt(350)).toBe('ctx_new')
    // Parked until the chat's next turn edge: delivered after its Dispatch settled.
    expect(sentAt(250)).toBe('ctx_old')
    expect(sentAt(50)).toBeUndefined()
  })
})
