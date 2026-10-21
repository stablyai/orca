import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import {
  nativeChatHookLatestTurnWorkedSeconds,
  nativeChatHookTurnStartedAt,
  nativeChatLatestTurnId,
  nativeChatTranscriptSettledTurns,
  resolveNativeChatTerminalTurn
} from './native-chat-terminal-turn'

const idle = {
  isConversation: true,
  working: false,
  hookAwaitingInput: false,
  interrupted: false,
  hasPromptCard: false
}

describe('resolveNativeChatTerminalTurn', () => {
  it('keeps the turn running while the agent waits, without calling it generating', () => {
    expect(resolveNativeChatTerminalTurn({ ...idle, hookAwaitingInput: true })).toEqual({
      isWorking: false,
      turnActive: true,
      awaitingInput: 'unshown'
    })
  })

  it('lets a prompt card speak for the wait', () => {
    expect(
      resolveNativeChatTerminalTurn({ ...idle, hookAwaitingInput: true, hasPromptCard: true })
    ).toEqual({ isWorking: false, turnActive: true, awaitingInput: 'shown' })
  })

  it('reports a generating turn with nothing awaited', () => {
    expect(resolveNativeChatTerminalTurn({ ...idle, working: true })).toEqual({
      isWorking: true,
      turnActive: true,
      awaitingInput: null
    })
  })

  // Stop is the reader's word that the turn is over, whatever the hook still says.
  it('ends the turn on local Stop, wait included', () => {
    expect(
      resolveNativeChatTerminalTurn({
        ...idle,
        working: true,
        hookAwaitingInput: true,
        interrupted: true
      })
    ).toEqual({ isWorking: false, turnActive: false, awaitingInput: null })
  })

  it('stays quiet with no turn at all', () => {
    expect(resolveNativeChatTerminalTurn(idle)).toEqual({
      isWorking: false,
      turnActive: false,
      awaitingInput: null
    })
  })
})

describe('nativeChatHookTurnStartedAt', () => {
  const entry = { state: 'working' as const, stateStartedAt: 3_000 }

  // Answered in the terminal: the current state began at 3s, the turn at 1s.
  it("dates the turn by the host's stamp, not the state it came back from", () => {
    expect(nativeChatHookTurnStartedAt({ ...entry, turnStartedAt: 1_000 })).toBe(1_000)
  })

  // A background task held the row 'working' since 500; the main agent's turn began at 8s.
  it('keeps the stamp when child work holds the row open', () => {
    expect(
      nativeChatHookTurnStartedAt({
        ...entry,
        stateStartedAt: 500,
        turnStartedAt: 8_000,
        mainAgent: { state: 'working', stateStartedAt: 8_000 }
      })
    ).toBe(8_000)
  })

  it("falls back to the main agent's own state start on a host that stamps no turn", () => {
    expect(
      nativeChatHookTurnStartedAt({
        ...entry,
        stateStartedAt: 500,
        mainAgent: { state: 'working', stateStartedAt: 8_000 }
      })
    ).toBe(8_000)
  })

  it('falls back to the row once the main agent is done, or where it has none', () => {
    expect(
      nativeChatHookTurnStartedAt({ ...entry, mainAgent: { state: 'done', stateStartedAt: 2_500 } })
    ).toBe(3_000)
    expect(nativeChatHookTurnStartedAt(entry)).toBe(3_000)
  })

  it('knows nothing without a status row', () => {
    expect(nativeChatHookTurnStartedAt(undefined)).toBeNull()
  })
})

describe('nativeChatHookLatestTurnWorkedSeconds', () => {
  const done = { state: 'done' as const, stateStartedAt: 91_000, turnStartedAt: 1_000 }

  it("times a turn the host ended from its turn start to the main agent's done", () => {
    expect(nativeChatHookLatestTurnWorkedSeconds(done, false)).toBe(90)
    // Child work still holds the row; the main agent's own end closes the turn.
    expect(
      nativeChatHookLatestTurnWorkedSeconds(
        { ...done, state: 'working', mainAgent: { state: 'done', stateStartedAt: 31_000 } },
        false
      )
    ).toBe(30)
  })

  // Staleness ages the row out of the pane, not the host's record that the turn finished.
  it('keeps a host-ended duration once the row is stale', () => {
    expect(nativeChatHookLatestTurnWorkedSeconds(done, true)).toBe(90)
  })

  it('hides a local end while the host went quiet mid-turn', () => {
    expect(
      nativeChatHookLatestTurnWorkedSeconds(
        { ...done, state: 'waiting', stateStartedAt: 2_000 },
        true
      )
    ).toBeNull()
  })

  // A pane-side end (Stop, the transcript's end marker) is the pane's own word; keep what it saw.
  it('keeps the local reading while the host is fresh and the turn not host-ended', () => {
    expect(
      nativeChatHookLatestTurnWorkedSeconds(
        { ...done, state: 'waiting', stateStartedAt: 2_000 },
        false
      )
    ).toBeUndefined()
  })

  it('invents no duration without the host turn stamp, or across a session boundary', () => {
    expect(
      nativeChatHookLatestTurnWorkedSeconds({ state: 'done', stateStartedAt: 91_000 }, false)
    ).toBeUndefined()
    expect(
      nativeChatHookLatestTurnWorkedSeconds({ ...done, sessionBoundary: true }, false)
    ).toBeUndefined()
    expect(nativeChatHookLatestTurnWorkedSeconds(undefined, true)).toBeUndefined()
  })
})

function row(
  id: string,
  role: NativeChatMessage['role'],
  timestamp: number | null
): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text: id }], timestamp, source: 'transcript' }
}

describe('nativeChatTranscriptSettledTurns', () => {
  it('times each finished turn from its prompt to its last row, leaving the latest out', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', 10_000),
      row('a1', 'assistant', 20_000),
      row('a2', 'assistant', 55_900),
      row('u2', 'user', 70_000),
      row('a3', 'assistant', 80_000)
    ])
    expect([...settled]).toEqual([['u1', { startedAt: 10_000, workedSeconds: 45 }]])
  })

  it('ends an interrupted turn at its interruption', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', 0),
      row('a1', 'assistant', 5_000),
      {
        ...row('stop', 'system', 12_000),
        blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }]
      },
      row('u2', 'user', 60_000)
    ])
    expect(settled.get('u1')).toEqual({ startedAt: 0, workedSeconds: 12 })
  })

  // An attachment row sits beside the next prompt; it does not stretch the turn before it.
  it('does not end a turn at a system row the agent did not write', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', 0),
      row('a1', 'assistant', 5_000),
      row('@src/index.ts', 'system', 3_600_000),
      row('u2', 'user', 3_601_000)
    ])
    expect(settled.get('u1')).toEqual({ startedAt: 0, workedSeconds: 5 })
  })

  // A harness notice (task notification, reminder) is user-role in the transcript but not a prompt.
  it('times a turn across a harness notice injected mid-turn', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', 0),
      row('a1', 'assistant', 5_000),
      {
        ...row('notice', 'user', 10_000),
        blocks: [{ type: 'text', text: '<task-notification>\n<task-id>b1</task-id>' }]
      },
      row('a2', 'assistant', 30_000),
      row('u2', 'user', 60_000)
    ])
    expect([...settled]).toEqual([['u1', { startedAt: 0, workedSeconds: 30 }]])
  })

  // Absent, not null: null would also hide the duration the pane measured itself.
  it('leaves out a turn missing either end', () => {
    const settled = nativeChatTranscriptSettledTurns([
      row('u1', 'user', null),
      row('a1', 'assistant', 5_000),
      row('u2', 'user', 10_000),
      row('a2', 'assistant', null),
      row('u3', 'user', 20_000)
    ])
    expect(settled.size).toBe(0)
  })
})

describe('nativeChatLatestTurnId', () => {
  it('names the last prompt, not a harness notice after it', () => {
    expect(
      nativeChatLatestTurnId([
        row('u1', 'user', 0),
        row('a1', 'assistant', 5_000),
        {
          ...row('notice', 'user', 10_000),
          blocks: [{ type: 'text', text: '<task-notification>\n<task-id>b1</task-id>' }]
        }
      ])
    ).toBe('u1')
    expect(nativeChatLatestTurnId([row('a1', 'assistant', 0)])).toBeNull()
  })
})
