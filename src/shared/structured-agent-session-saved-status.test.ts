import { describe, expect, it } from 'vitest'
import {
  parseSavedStructuredSessionStatus,
  savedStructuredSessionStatusChanged,
  savedStructuredSessionSummary
} from './structured-agent-session-saved-status'

const summary = {
  sessionId: 'chat-1',
  status: 'idle',
  latestPrompt: 'ship it',
  turnOutcome: 'success',
  updatedAt: 10
}

describe('a saved chat status read back from disk', () => {
  it('keeps a well-formed entry', () => {
    expect(parseSavedStructuredSessionStatus('chat-1', { summary })).toEqual({ summary })
  })

  it.each([
    ['not an object', 'chat-1', 'idle'],
    ['no summary', 'chat-1', {}],
    ['a summary under another chat', 'chat-2', { summary }],
    ['an unknown status', 'chat-1', { summary: { ...summary, status: 'thinking' } }],
    ['no clock', 'chat-1', { summary: { ...summary, updatedAt: 'yesterday' } }],
    ['no prompt', 'chat-1', { summary: { ...summary, latestPrompt: undefined } }]
  ])('rejects %s', (_why, sessionId, value) => {
    expect(parseSavedStructuredSessionStatus(sessionId, value)).toBeNull()
  })

  it("keeps only the journal's half, drops fields of the wrong shape, and a verdict on a busy chat", () => {
    expect(
      savedStructuredSessionSummary({
        ...summary,
        workspaceId: 'workspace-1',
        agent: 'claude',
        status: 'working',
        model: 'gpt-live',
        hostExecutionOwned: true,
        toolName: 'Bash',
        lastAssistantMessage: '',
        statusStartedAt: -1
      })
    ).toEqual({
      sessionId: 'chat-1',
      status: 'working',
      latestPrompt: 'ship it',
      updatedAt: 10
    })
  })

  it('reads an unknown verdict from a newer build as no verdict', () => {
    expect(savedStructuredSessionSummary({ ...summary, turnOutcome: 'paused' })).not.toHaveProperty(
      'turnOutcome'
    )
  })
})

describe('when a save is owed', () => {
  const idle = {
    sessionId: 'chat-1',
    status: 'idle' as const,
    latestPrompt: 'ship it',
    updatedAt: 10
  }

  it('is owed for a first save, a status edge and a verdict edge only', () => {
    expect(savedStructuredSessionStatusChanged(undefined, idle)).toBe(true)
    expect(savedStructuredSessionStatusChanged(idle, { ...idle, status: 'working' })).toBe(true)
    expect(savedStructuredSessionStatusChanged(idle, { ...idle, turnOutcome: 'failure' })).toBe(
      true
    )
    expect(
      savedStructuredSessionStatusChanged(idle, {
        ...idle,
        lastAssistantMessage: 'more text',
        updatedAt: 99
      })
    ).toBe(false)
  })
})
