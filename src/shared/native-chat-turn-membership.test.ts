import { describe, expect, it } from 'vitest'
import { agentJournalItemKey, agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { nativeChatTurnKeys, structuredAgentTurnAnchors } from './native-chat-turn-membership'
import type { NativeChatRole } from './native-chat-types'

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
let sequence = 0

function item(
  itemId: string,
  body: AgentJournalItemBody,
  /** Null for a host that predates scopes. */
  turnScope: AgentJournalTurnScope | null = THREAD
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body,
    ...(turnScope ? { turnScope } : {})
  }
}

const user = (itemId: string, scope?: AgentJournalTurnScope | null) =>
  item(itemId, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }, scope)
const assistant = (itemId: string, scope?: AgentJournalTurnScope | null) =>
  item(
    itemId,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: itemId }] },
    scope
  )
const status = (itemId: string, scope?: AgentJournalTurnScope | null) =>
  item(itemId, { kind: 'status', text: itemId }, scope)
const turn = (
  itemId: string,
  userItemId: string | undefined,
  scope?: AgentJournalTurnScope | null
) =>
  item(
    itemId,
    {
      kind: 'turn',
      turnId: itemId,
      state: 'completed',
      ...(userItemId === undefined ? {} : { userItemId })
    },
    scope
  )
const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })

/** Rows as a surface hands them over: journal items that draw, in order. */
function rows(items: readonly AgentJournalRenderItem[]): { id: string; role: NativeChatRole }[] {
  return items.flatMap((entry): { id: string; role: NativeChatRole }[] => {
    if (entry.body.kind === 'message') {
      return [{ id: entry.itemId, role: entry.body.role === 'user' ? 'user' : 'assistant' }]
    }
    return entry.body.kind === 'status' ? [{ id: entry.itemId, role: 'system' }] : []
  })
}

function keys(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
) {
  return nativeChatTurnKeys(rows(items), { items, submissions })
}

describe('nativeChatTurnKeys', () => {
  it('groups rows by the turn their scope names, and a steer into the turn it joined', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1'),
      assistant('a1', inTurn('t1')),
      user('steer', inTurn('t1')),
      assistant('a2', inTurn('t1')),
      status('note')
    ]
    expect(keys(items)).toEqual(['u1', 'u1', 'u1', 'u1', undefined])
  })

  it('keys a turn no message opened on its own record', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1'),
      assistant('a1', inTurn('t1')),
      // A provider-resumed turn: its record names no present user entry.
      turn('wake', 'codex:thread:wake:0'),
      assistant('a2', inTurn('wake'))
    ]
    expect(keys(items)).toEqual(['u1', 'u1', 'wake'])
  })

  it('anchors a command turn on its /compact entry, and leaves the turn before it alone', () => {
    const compactKey = agentJournalSubmissionKey('cmd-1')
    const commandTurn = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: 'command-turn:cmd-1'
    })
    const items = [
      user('u1'),
      turn('t1', 'u1'),
      assistant('a1', inTurn('t1')),
      item(compactKey, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }),
      turn(commandTurn, compactKey),
      status('compacted', inTurn(commandTurn))
    ]
    expect(keys(items)).toEqual(['u1', 'u1', compactKey, compactKey])
  })

  it('resolves a turn record naming the provider item a submission adopted', () => {
    const sent = agentJournalSubmissionKey('send-1')
    const items = [user(sent), turn('t1', 'codex:thread:t1:0'), assistant('a1', inTurn('t1'))]
    const submissions: AgentJournalSubmission[] = [
      {
        clientMessageId: 'send-1',
        fence: 1,
        payloadFingerprint: 'f',
        dispatchState: 'accepted',
        providerItemId: 'codex:thread:t1:0',
        reason: null,
        submittedAt: 1,
        resolvedAt: 2
      }
    ]
    expect(keys(items, submissions)).toEqual([sent, sent])
    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe(sent)
  })

  it('places a conversation row, and a row naming a turn the journal no longer holds, in none', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1'),
      status('restart-note'),
      assistant('orphan', inTurn('gone'))
    ]
    expect(keys(items)).toEqual(['u1', undefined, undefined])
  })

  it('groups by position for a host that states no scope, and with no journal', () => {
    const items = [user('u1', null), assistant('a1', null), user('u2', null), status('s', null)]
    expect(keys(items)).toEqual(['u1', 'u1', 'u2', 'u2'])
    expect(nativeChatTurnKeys(rows(items))).toEqual(['u1', 'u1', 'u2', 'u2'])
  })
})
