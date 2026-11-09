import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  mergeNativeChatLiveSession,
  nativeChatHookAwaitsInput,
  nativeChatHookHasWorkingSubagents
} from './native-chat-live-status'
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
    expect(session.hookWorking).toBe(false)
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

  it('keeps a completed lead working while the producer roster has a live child, then settles', async () => {
    const text = await readFile(
      new URL('../../main/acp/fixtures/omp-subagents-roster.jsonl', import.meta.url),
      'utf8'
    )
    const frames: { children: { id: string; status: string; updatedAt: number }[] }[] = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const subagentsOf = (children: (typeof frames)[number]['children']) =>
      children
        .filter((child) => child.status === 'running')
        .map((child) => ({ id: child.id, state: 'working' as const, startedAt: child.updatedAt }))
    const base = {
      messages: [assistant('a-1', 'lead done')],
      sessionId: 'session-a',
      agent: 'omp' as const,
      hookState: 'working' as const,
      stateStartedAt: 0,
      transcriptLifecycle: { state: 'completed' as const, turnId: 'turn-1', timestamp: 2 }
    }
    const liveRoster = { stateStartedAt: 0, subagents: subagentsOf(frames[0].children) }
    expect(
      mergeNativeChatLiveSession({
        ...base,
        hookHasWorkingSubagents: nativeChatHookHasWorkingSubagents(liveRoster)
      }).status
    ).toBe('working')
    const settledRoster = { stateStartedAt: 0, subagents: subagentsOf(frames[3].children) }
    expect(
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'done',
        hookHasWorkingSubagents: nativeChatHookHasWorkingSubagents(settledRoster)
      }).status
    ).toBe('ready')
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
      hookState: 'working',
      error: 'unreadable'
    })
    expect(errored.status).toBe('error')
    expect(errored.error).toBe('unreadable')
    expect(errored.hookWorking).toBe(true)
  })
})

describe('nativeChatHookAwaitsInput', () => {
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
