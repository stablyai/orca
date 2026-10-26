import { describe, it, expect } from 'vitest'
import type { NativeChatMessage, NativeChatSession } from '../../../../shared/native-chat-types'
import { selectNativeChatViewState, structuredChatHistoryPhase } from './native-chat-view-state'

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

  it('maps error with its message when nothing has loaded (P2-21)', () => {
    const state = selectNativeChatViewState(
      session({ messages: [], status: 'error', error: 'boom' })
    )
    expect(state).toEqual({ kind: 'error', message: 'boom' })
  })

  it('maps an error with no text to no message', () => {
    expect(selectNativeChatViewState(session({ messages: [], status: 'error' }))).toEqual({
      kind: 'error'
    })
  })

  it('keeps a loaded transcript on screen when a later read fails (P2-21)', () => {
    const state = selectNativeChatViewState(session({ status: 'error', error: 'boom' }), {
      readRetries: true
    })
    expect(state).toEqual({ kind: 'ready', isWorking: false })
  })

  // Terminal reads do not retry; local echoes must not hide errors or the route back to the terminal.
  it('shows a terminal-backed read error over local echoes', () => {
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

  // Unflushed known sessions stay loading instead of flashing empty (#11032).
  it('holds loading for a known session working before its transcript flushes', () => {
    expect(selectNativeChatViewState(session({ messages: [], status: 'working' })).kind).toBe(
      'loading'
    )
  })

  // The composer reads session.status, which must retain working for Stop while the view loads.
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
})

describe('structuredChatHistoryPhase', () => {
  const reopened = { lifecycle: null, transportEnabled: true }

  it('reads a reopened chat until its first read settles', () => {
    expect(structuredChatHistoryPhase(reopened, 'idle')).toBe('reading')
    expect(structuredChatHistoryPhase(reopened, 'loading')).toBe('reading')
    expect(structuredChatHistoryPhase(reopened, 'ready')).toBe('known')
  })

  it('reads a resume only while its launch is in flight', () => {
    const resume = { launch: { kind: 'resume' as const }, transportEnabled: false }
    expect(structuredChatHistoryPhase({ ...resume, lifecycle: 'pending' }, 'ready')).toBe('reading')
    expect(structuredChatHistoryPhase({ ...resume, lifecycle: 'failed' }, 'ready')).toBe('unread')
    expect(
      structuredChatHistoryPhase({ ...resume, lifecycle: 'visibility-unknown' }, 'ready')
    ).toBe('unread')
  })

  it('knows a chat this pane started new, and a cancelled launch', () => {
    const fresh = { launch: { kind: 'new' as const }, lifecycle: null, transportEnabled: true }
    expect(structuredChatHistoryPhase(fresh, 'idle')).toBe('known')
    expect(
      structuredChatHistoryPhase({ lifecycle: 'cancelled', transportEnabled: false }, 'ready')
    ).toBe('known')
  })
})
