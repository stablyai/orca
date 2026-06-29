import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { mergeNativeChatLiveSession } from './native-chat-live-status'

// These exercise the hook's merge core (mergeNativeChatLiveSession), which is
// the pure decision the hook delegates to after doing IPC + store reads. The
// React wiring (subscribe/unsubscribe lifecycle) is covered by the main-side
// transcript-watch + IPC tests; here we pin the live-status precedence rules.

function assistant(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 2,
    source: 'transcript'
  }
}

function user(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

describe('mergeNativeChatLiveSession', () => {
  it("surfaces live 'working' before the assistant turn lands in the transcript", () => {
    // The user prompt is in the transcript but the assistant has not replied
    // yet; the hook reports the agent is working.
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [user('u-1', 'do a thing')] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working'
    })
    expect(session.status).toBe('working')
    expect(session.messages).toHaveLength(1)
  })

  it("clears 'working' once the assistant message flushes to the transcript", () => {
    // Same pane, but now the transcript's last message is the assistant reply —
    // the turn is visible, so 'working' is superseded by the derived 'ready'.
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [user('u-1', 'do a thing'), assistant('a-1', 'done')] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working'
    })
    expect(session.status).toBe('ready')
  })

  it('leaves completed states (done/waiting/blocked) on the derived status', () => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [user('u-1', 'hi')] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'done'
    })
    expect(session.status).toBe('ready')
  })

  it('honors loading and error overrides outright', () => {
    expect(
      mergeNativeChatLiveSession({
        sources: { transcript: [] },
        sessionId: null,
        agent: 'claude',
        hookState: 'working',
        loading: true
      }).status
    ).toBe('loading')

    const errored = mergeNativeChatLiveSession({
      sources: { transcript: [] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: null,
      error: 'unreadable'
    })
    expect(errored.status).toBe('error')
    expect(errored.error).toBe('unreadable')
  })

  it('assembles an empty transcript with no live work as empty', () => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: [] },
      sessionId: 'sess',
      agent: 'claude',
      hookState: null
    })
    expect(session.status).toBe('empty')
  })
})
