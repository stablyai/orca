import { describe, it, expect } from 'vitest'
import type { NativeChatMessage, NativeChatSession } from '../../../../shared/native-chat-types'
import { selectNativeChatViewState } from './native-chat-view-state'

const message: NativeChatMessage = {
  id: 'a',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'hi' }],
  timestamp: 1,
  source: 'transcript'
}

function session(overrides: Partial<NativeChatSession>): NativeChatSession {
  return {
    messages: [message],
    status: 'ready',
    sessionId: 'sess',
    agent: 'claude',
    ...overrides
  }
}

describe('selectNativeChatViewState', () => {
  it('maps loading', () => {
    expect(selectNativeChatViewState(session({ messages: [], status: 'loading' })).kind).toBe(
      'loading'
    )
  })

  it('keeps rendering messages while the session reports loading', () => {
    expect(selectNativeChatViewState(session({ status: 'loading' }))).toEqual({
      kind: 'ready',
      isWorking: false
    })
  })

  it('maps error with its message', () => {
    const state = selectNativeChatViewState(session({ status: 'error', error: 'boom' }))
    expect(state).toEqual({ kind: 'error', message: 'boom' })
  })

  it('maps empty when there are no messages', () => {
    expect(selectNativeChatViewState(session({ messages: [], status: 'ready' })).kind).toBe('empty')
  })

  it('empty wins over a working hook on a pre-session conversation', () => {
    expect(
      selectNativeChatViewState(session({ messages: [], status: 'working', sessionId: null })).kind
    ).toBe('empty')
  })

  // A known session working with nothing to show is a transcript that has not
  // flushed yet (#11032), so hold loading rather than flash the empty state.
  it('holds loading for a known session working before its transcript flushes', () => {
    expect(selectNativeChatViewState(session({ messages: [], status: 'working' })).kind).toBe(
      'loading'
    )
  })

  // Why status, not view state: the composer reads session.status, so the pane
  // must offer Stop the moment a bubble lands mid-turn.
  it('keeps working status for a known session so the composer can offer Stop', () => {
    expect(selectNativeChatViewState(session({ status: 'working' }))).toEqual({
      kind: 'ready',
      isWorking: true
    })
  })

  it('maps ready (not working)', () => {
    expect(selectNativeChatViewState(session({ status: 'ready' }))).toEqual({
      kind: 'ready',
      isWorking: false
    })
  })

  it('maps ready working when the agent is mid-turn', () => {
    expect(selectNativeChatViewState(session({ status: 'working' }))).toEqual({
      kind: 'ready',
      isWorking: true
    })
  })
})
