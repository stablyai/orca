import { describe, expect, it } from 'vitest'
import {
  readStructuredTurnCompletionEvent,
  structuredTurnCompletionKey
} from './structured-turn-completion'

const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
} as const

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'completion',
    completion: {
      scope: SCOPE,
      sessionId: 'session-1',
      turnId: 'turn-1',
      outcome: 'success',
      completedAt: 1_700,
      ...overrides
    }
  }
}

describe('readStructuredTurnCompletionEvent', () => {
  it('reads a completion', () => {
    expect(readStructuredTurnCompletionEvent(frame())).toEqual({
      type: 'completion',
      completion: {
        scope: SCOPE,
        sessionId: 'session-1',
        turnId: 'turn-1',
        outcome: 'success',
        completedAt: 1_700
      }
    })
  })

  it('reads the stream end', () => {
    expect(readStructuredTurnCompletionEvent({ type: 'end' })).toEqual({
      type: 'end'
    })
  })

  it('keeps reading a newer host that added fields it has never heard of', () => {
    const event = readStructuredTurnCompletionEvent({
      ...frame({ tokensUsed: 4_096, scope: { ...SCOPE, datacentre: 'iad' } }),
      priority: 'high'
    })
    expect(event?.type).toBe('completion')
    if (event?.type !== 'completion') {
      throw new Error('a forward-compatible frame must still read')
    }
    // Unknown keys are ignored, and the scope is rebuilt from the members this build knows, so a
    // newer host's extra scope field cannot silently change the dedupe identity either.
    expect(event.completion.scope).toEqual(SCOPE)
  })

  it('refuses an outcome arm from a later vocabulary rather than inventing a verdict', () => {
    // A degrade-to-`success` here would light a dot for something this build cannot place;
    // refusing matches the answer it gives for a turn whose outcome was never recorded.
    expect(readStructuredTurnCompletionEvent(frame({ outcome: 'partial-success' }))).toBeNull()
  })

  it.each([
    ['an absent outcome', frame({ outcome: undefined })],
    ['an empty session id', frame({ sessionId: '' })],
    ['an empty turn id', frame({ turnId: '' })],
    [
      'an unparseable execution host',
      frame({ scope: { ...SCOPE, executionHostId: 'nonsense:x' } })
    ],
    ['a non-numeric clock', frame({ completedAt: 'soon' })],
    ['an infinite clock', frame({ completedAt: Number.POSITIVE_INFINITY })],
    ['an unknown workspace kind', frame({ scope: { ...SCOPE, workspaceKind: 'shelf' } })],
    ['a missing completion', { type: 'completion' }],
    ['an unknown event type', { type: 'progress' }],
    ['a non-object', 'completion'],
    ['null', null]
  ])('refuses %s', (_label, value) => {
    expect(readStructuredTurnCompletionEvent(value)).toBeNull()
  })

  it('normalizes the execution host so the dedupe scope matches what this build writes', () => {
    const event = readStructuredTurnCompletionEvent(
      frame({ scope: { ...SCOPE, executionHostId: 'ssh:box-1' } })
    )
    if (event?.type !== 'completion') {
      throw new Error('a valid ssh host must read')
    }
    expect(event.completion.scope.executionHostId).toBe('ssh:box-1')
  })
})

describe('structuredTurnCompletionKey', () => {
  it('separates every part, so no two identities can collide by concatenation', () => {
    const left = structuredTurnCompletionKey({
      scope: SCOPE,
      sessionId: 'a',
      turnId: 'b:c'
    })
    const right = structuredTurnCompletionKey({
      scope: SCOPE,
      sessionId: 'a:b',
      turnId: 'c'
    })
    expect(left).not.toBe(right)
  })
})
