import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { mergeNativeChatLiveSession, nativeChatHookAwaitsInput } from './native-chat-live-status'
import { shouldShowNativeChatWorking } from './native-chat-working-suppression'

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
    const session = mergeNativeChatLiveSession({
      messages: [user('u-1', 'do a thing')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working'
    })
    expect(session.status).toBe('working')
    expect(session.messages).toHaveLength(1)
  })

  it("keeps 'working' authoritative when a prior assistant message is present", () => {
    const session = mergeNativeChatLiveSession({
      messages: [user('u-1', 'do a thing'), assistant('a-1', 'done')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working'
    })
    expect(session.status).toBe('working')
  })

  it('does not treat assistant prose as turn completion while lifecycle is mid-generation', () => {
    const session = mergeNativeChatLiveSession({
      messages: [user('u-1', 'go'), assistant('a-1', 'done')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 1,
      transcriptLifecycle: { state: 'working', turnId: 'u-1', timestamp: 1 }
    })
    expect(session.status).toBe('working')
  })

  it('recovers via assistant prose when capable host has no in-progress lifecycle', () => {
    const session = mergeNativeChatLiveSession({
      messages: [user('u-1', 'go'), assistant('a-1', 'done')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 1
    })
    expect(session.status).toBe('ready')
  })

  it('settles a dropped working hook from an explicit completion marker', () => {
    const session = mergeNativeChatLiveSession({
      messages: [user('u-1', 'go'), assistant('a-1', 'done')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 1,
      transcriptLifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 2 }
    })
    expect(session.status).toBe('ready')
  })

  it('settles a dropped working hook from an explicit interruption marker', () => {
    const session = mergeNativeChatLiveSession({
      messages: [user('u-1', 'go')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 1,
      transcriptLifecycle: { state: 'interrupted', turnId: 'turn-1', timestamp: 2 }
    })
    expect(session.status).toBe('ready')
  })

  it('does not apply an older completion marker to a newer working turn', () => {
    const session = mergeNativeChatLiveSession({
      messages: [assistant('a-1', 'prior')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 5,
      transcriptLifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 2 }
    })
    expect(session.status).toBe('working')
  })

  it('does not apply an older interruption marker to a newer working turn', () => {
    const session = mergeNativeChatLiveSession({
      messages: [assistant('a-1', 'prior')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 5,
      transcriptLifecycle: { state: 'interrupted', turnId: 'turn-1', timestamp: 2 }
    })
    expect(session.status).toBe('working')
  })

  it('settles an unorderable (null-timestamp) completion marker for live work', () => {
    const session = mergeNativeChatLiveSession({
      messages: [assistant('a-1', 'prior')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 5,
      transcriptLifecycle: { state: 'completed', turnId: 'turn-1', timestamp: null }
    })
    expect(session.status).toBe('ready')
  })

  it('settles a completion slightly before hook receipt within clock-skew slack', () => {
    const hookStartedAt = 1_700_000_000_000
    const session = mergeNativeChatLiveSession({
      messages: [assistant('a-1', 'done')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: hookStartedAt,
      transcriptLifecycle: {
        state: 'completed',
        turnId: 'turn-1',
        timestamp: hookStartedAt - 500
      }
    })
    expect(session.status).toBe('ready')
  })

  it('preserves the assistant fallback when the serving host lacks explicit boundaries', () => {
    const session = mergeNativeChatLiveSession({
      messages: [assistant('a-1', 'done')],
      sessionId: 'sess',
      agent: 'grok',
      hookState: 'working',
      stateStartedAt: 1
    })
    expect(session.status).toBe('ready')
  })

  it("keeps omp working while its latest row is a tool call written after the turn's start", () => {
    // Shaped as decodeOmpTranscriptLine emits them: every omp row carries its timestamp.
    const turnStartedAt = Date.parse('2026-09-28T10:00:00.000Z')
    const toolCall: NativeChatMessage = {
      id: 'rec-2',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Running the suite.' },
        { type: 'tool-call', name: 'bash', input: { command: 'pnpm test' } }
      ],
      timestamp: turnStartedAt + 4_000,
      source: 'transcript'
    }
    const session = mergeNativeChatLiveSession({
      messages: [{ ...user('rec-1', 'run the tests'), timestamp: turnStartedAt }, toolCall],
      sessionId: 'sess',
      agent: 'omp',
      hookState: 'working',
      stateStartedAt: turnStartedAt
    })
    expect(session.status).toBe('working')
    expect(
      shouldShowNativeChatWorking({
        isConversation: true,
        working: session.status === 'working',
        interrupted: false
      })
    ).toBe(true)
  })

  it('keeps working while the hook reports a live background child', () => {
    const session = mergeNativeChatLiveSession({
      messages: [assistant('a-1', 'lead done')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 1,
      transcriptLifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 2 },
      hookHasWorkingSubagents: true
    })
    expect(session.status).toBe('working')
  })

  it('settles on an interruption even while the hook reports a live background child', () => {
    const session = mergeNativeChatLiveSession({
      messages: [assistant('a-1', 'lead done')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 1,
      transcriptLifecycle: { state: 'interrupted', turnId: 'turn-1', timestamp: 2 },
      hookHasWorkingSubagents: true
    })
    expect(session.status).toBe('ready')
  })

  it('leaves completed states (done/waiting/blocked) on the derived status', () => {
    const session = mergeNativeChatLiveSession({
      messages: [user('u-1', 'hi')],
      sessionId: 'sess',
      agent: 'claude',
      hookState: 'done'
    })
    expect(session.status).toBe('ready')
  })

  it('surfaces live work while the transcript loads and honors errors outright', () => {
    expect(
      mergeNativeChatLiveSession({
        messages: [],
        sessionId: null,
        agent: 'claude',
        hookState: 'working',
        loading: true
      }).status
    ).toBe('working')
    // Keep working authoritative for controls; selectNativeChatViewState owns the empty-transcript loading surface.
    expect(
      mergeNativeChatLiveSession({
        messages: [],
        sessionId: 'sess',
        agent: 'claude',
        hookState: 'working',
        loading: true
      }).status
    ).toBe('working')

    // Pending echoes, launch bubbles and command markers already make the conversation renderable.
    expect(
      mergeNativeChatLiveSession({
        messages: [user('u-1', 'run it')],
        sessionId: 'sess',
        agent: 'claude',
        hookState: 'working',
        loading: true
      }).status
    ).toBe('working')

    const errored = mergeNativeChatLiveSession({
      messages: [],
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
      messages: [],
      sessionId: 'sess',
      agent: 'claude',
      hookState: null
    })
    expect(session.status).toBe('empty')
  })
})

describe('nativeChatHookAwaitsInput', () => {
  it.each(['waiting', 'blocked'] as const)('reads a %s hook as a wait on the reader', (state) => {
    expect(nativeChatHookAwaitsInput(state, 5, undefined)).toBe(true)
    expect(
      nativeChatHookAwaitsInput(state, 5, { state: 'working', turnId: 'turn-1', timestamp: 1 })
    ).toBe(true)
  })

  it('reads no other hook state as a wait', () => {
    expect(nativeChatHookAwaitsInput('working', 5, undefined)).toBe(false)
    expect(nativeChatHookAwaitsInput('done', 5, undefined)).toBe(false)
    expect(nativeChatHookAwaitsInput(null, 5, undefined)).toBe(false)
  })

  // An interrupt at the prompt fires no hook; the transcript's marker is the only end.
  it('ends a wait the transcript closed after it began', () => {
    expect(
      nativeChatHookAwaitsInput('waiting', 5, {
        state: 'interrupted',
        turnId: 'turn-1',
        timestamp: 6
      })
    ).toBe(false)
    expect(
      nativeChatHookAwaitsInput('waiting', 5, {
        state: 'completed',
        turnId: 'turn-1',
        timestamp: 6
      })
    ).toBe(false)
  })

  it('keeps a wait that began after the last closed turn', () => {
    expect(
      nativeChatHookAwaitsInput('waiting', 5, {
        state: 'interrupted',
        turnId: 'turn-1',
        timestamp: 2
      })
    ).toBe(true)
  })
})
