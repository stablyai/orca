import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import {
  nativeChatFirstScreen,
  nativeChatFirstScreenSignIn,
  nativeChatKickoffEnded,
  nativeChatKickoffRefusal
} from './bot-first-screen'

function message(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript',
    ...extra
  }
}

const kickoff = message('k', 'user', 'Orca: you were just created.', { orcaNotice: 'bot-created' })

describe('nativeChatFirstScreen', () => {
  const read: NativeChatMessage = {
    id: 'r',
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'gh pr list' } }],
    timestamp: 1,
    source: 'transcript'
  }
  const narration = message('n', 'assistant', 'Let me look around first.')

  it('shows while the first turn runs, and gives way as soon as the bot speaks', () => {
    expect(nativeChatFirstScreen([kickoff, read], false)).toEqual({
      phase: 'starting',
      turn: [read],
      refused: null
    })
    expect(nativeChatFirstScreen([kickoff, read, narration], false)).toBeNull()
  })

  it('fails when the turn ends without a word, and follows the latest kickoff', () => {
    const again = { ...kickoff, id: 'k2' }
    expect(nativeChatFirstScreen([kickoff, read], true)).toEqual({
      phase: 'failed',
      turn: [read],
      refused: null
    })
    expect(nativeChatFirstScreen([kickoff, read, again], false)).toEqual({
      phase: 'starting',
      turn: [],
      refused: null
    })
  })

  it("gives way at once to an import's plan, which waits on the owner", () => {
    const plan = message('p', 'system', 'Import plan: Molty from OpenClaw', {
      blocks: [
        {
          type: 'text',
          text: 'Import plan: Molty from OpenClaw',
          botImportPlan: {
            botId: 'b1',
            app: 'OpenClaw',
            name: 'Molty',
            items: [{ group: 'comes', what: 'Soul', why: 'Its persona.' }]
          }
        }
      ]
    })
    expect(nativeChatFirstScreen([kickoff, read, plan], false)).toBeNull()
  })

  it('is gone once the owner writes, and absent from any other chat', () => {
    expect(nativeChatFirstScreen([kickoff, message('u', 'user', 'Hi')], false)).toBeNull()
    expect(nativeChatFirstScreen([read], false)).toBeNull()
  })
})

it('shows a pending kickoff until the host refuses it before a turn opens', () => {
  const pending = {
    isWorking: false,
    latestTurn: null,
    submissions: [{ dispatchState: 'pending' as const, reason: null }]
  }
  expect(
    nativeChatFirstScreen(
      [kickoff],
      nativeChatKickoffEnded(pending),
      nativeChatKickoffRefusal(pending)
    )
  ).toEqual({ phase: 'starting', turn: [], refused: null })

  const refused = {
    ...pending,
    submissions: [{ dispatchState: 'rejected' as const, reason: 'Claude Code could not start.' }]
  }
  expect(
    nativeChatFirstScreen(
      [kickoff],
      nativeChatKickoffEnded(refused),
      nativeChatKickoffRefusal(refused)
    )
  ).toEqual({ phase: 'failed', turn: [], refused: { reason: 'Claude Code could not start.' } })
})

describe('nativeChatFirstScreenSignIn', () => {
  const failedTurn = (kind: 'notSignedIn' | 'startFailed'): NativeChatMessage => ({
    ...message('f', 'system', 'Antigravity isn’t signed in.'),
    blocks: [
      {
        type: 'text',
        text: 'Antigravity isn’t signed in.',
        failure: { kind, account: 'system' }
      }
    ]
  })

  it('asks for agy’s sign-in only when the first turn failed signed out', () => {
    expect(
      nativeChatFirstScreenSignIn(nativeChatFirstScreen([kickoff, failedTurn('notSignedIn')], true))
    ).toEqual({ account: 'system' })
    expect(
      nativeChatFirstScreenSignIn(nativeChatFirstScreen([kickoff, failedTurn('startFailed')], true))
    ).toBeNull()
  })
})
