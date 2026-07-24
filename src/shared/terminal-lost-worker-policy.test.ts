import { describe, expect, it } from 'vitest'
import { classifyLostTerminal } from './terminal-lost-worker-policy'

describe('classifyLostTerminal', () => {
  it('classifies every durable worker fact independently and together', () => {
    expect(
      classifyLostTerminal({ providerSession: { key: 'session_id', id: 'session-1' } })
    ).toEqual({ kind: 'worker', evidence: ['provider-session'] })
    expect(classifyLostTerminal({ orchestrationTaskId: 'task-1' })).toEqual({
      kind: 'worker',
      evidence: ['orchestration-task']
    })
    expect(classifyLostTerminal({ launchAgent: 'codex' })).toEqual({
      kind: 'worker',
      evidence: ['launch-agent']
    })
    expect(
      classifyLostTerminal({
        providerSession: { key: 'conversation_id', id: 'conversation-1' },
        orchestrationTaskId: 'task-1',
        launchAgent: 'claude'
      })
    ).toEqual({
      kind: 'worker',
      evidence: ['provider-session', 'orchestration-task', 'launch-agent']
    })
  })

  it('fails closed for malformed durable facts and agent-like commands', () => {
    expect(
      classifyLostTerminal({
        providerSession: { key: 'unknown', id: 'session-1' } as never,
        orchestrationTaskId: ' task-1 ',
        launchAgent: 'unknown' as never
      })
    ).toEqual({ kind: 'ordinary-shell' })
    expect(
      classifyLostTerminal({
        startupCommand: 'codex --resume session-1'
      } as never)
    ).toEqual({ kind: 'ordinary-shell' })
  })
})
