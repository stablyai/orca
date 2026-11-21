import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../agent-session/journal/agent-session-journal-types'
import {
  botGroupTurnOperation,
  indexBotGroupJournal,
  type BotGroupMessage,
  type BotGroupTurn
} from './bot-group'
import {
  botGroupSteeredOperations,
  isQuietEmptyBotGroupMailTurn,
  visibleBotGroupMessages,
  type BotGroupSessionTurnSource
} from './bot-group-visible-turns'

const row = (
  itemId: string,
  body: AgentJournalRenderItem['body'],
  turnId?: string
): AgentJournalRenderItem => ({
  itemId,
  body,
  revision: 1,
  sequence: 1,
  observedAt: 1,
  turnScope: turnId ? { kind: 'turn', turnItemId: turnId } : { kind: 'thread' }
})

const makeTurn = (operationId: string, overrides: Partial<BotGroupTurn> = {}): BotGroupTurn => ({
  operationId,
  botId: 'bot-0',
  botName: 'SPC',
  avatar: null,
  agent: 'codex',
  sessionId: 'bot-group-member-0',
  ...overrides
})

const completedTurn = (
  itemId: string,
  outcome?: 'success' | 'failure' | 'cancellation' | 'superseded'
) =>
  row(itemId, {
    kind: 'turn',
    turnId: itemId,
    state: 'completed',
    ...(outcome ? { outcome } : {}),
    startedAt: 1,
    completedAt: 2
  })

describe('bot group visible turns', () => {
  it('hides a steered mail follow-up that shares an earlier turn and keeps turn ownership on the opener', () => {
    const openerKey = agentJournalSubmissionKey('op-1')
    const steeredKey = agentJournalSubmissionKey('op-2')
    const snapshot: AgentJournalSnapshot = {
      sessionId: 'bot-group-member-0',
      cursor: { epoch: 'e', sequence: 5 },
      submissions: [
        {
          clientMessageId: 'op-1',
          fence: 1,
          payloadFingerprint: 'f1',
          dispatchState: 'accepted',
          providerItemId: openerKey,
          reason: null,
          submittedAt: 1,
          resolvedAt: 2,
          answeredInTurn: { turnItemId: 'turn-1', via: 'start' }
        },
        {
          clientMessageId: 'op-2',
          fence: 1,
          payloadFingerprint: 'f2',
          dispatchState: 'accepted',
          providerItemId: steeredKey,
          reason: null,
          submittedAt: 3,
          resolvedAt: 4,
          answeredInTurn: { turnItemId: 'turn-1', via: 'steer' }
        }
      ],
      items: [
        row(openerKey, {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'fix it' }]
        }),
        row('turn-1', {
          kind: 'turn',
          turnId: 't1',
          state: 'completed',
          userItemId: openerKey,
          startedAt: 1,
          completedAt: 10
        }),
        row(
          steeredKey,
          { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'worker report' }] },
          'turn-1'
        ),
        row(
          'reply-1',
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Handled both.' }] },
          'turn-1'
        )
      ]
    }
    const steeredOperations = botGroupSteeredOperations(snapshot, ['op-1', 'op-2'])
    expect([...steeredOperations]).toEqual(['op-2'])
    expect(botGroupTurnOperation(snapshot, 'turn-1')).toBe('op-1')

    const sessions = new Map<string, BotGroupSessionTurnSource>([
      ['bot-group-member-0', { groupTurnItems: indexBotGroupJournal(snapshot), steeredOperations }]
    ])
    const messages: BotGroupMessage[] = [
      {
        id: 'owner-post',
        groupId: 'g',
        sequence: 1,
        author: { kind: 'owner' },
        text: '@SPC fix it',
        createdAt: 1,
        turns: [makeTurn('op-1')]
      },
      {
        id: 'mail:bot-group-member-0:m1',
        groupId: 'g',
        sequence: 2,
        author: { kind: 'bot', id: 'bot-0', name: 'SPC' },
        text: 'SPC followed up',
        createdAt: 2,
        rootRequestId: 'owner-post',
        rootSequence: 1,
        turns: [makeTurn('op-2', { mailbox: true })]
      }
    ]
    expect(visibleBotGroupMessages(messages, sessions).map((message) => message.id)).toEqual([
      'owner-post'
    ])
    // Also hides cross-page steered mail when the opener is on an earlier unloaded page.
    expect(visibleBotGroupMessages([messages[1]!], sessions)).toEqual([])
  })

  it('hides settled empty NO_REPLY mail turns while keeping turns with cards, answers, errors, or active work', () => {
    const quietMailItems = [
      completedTurn('turn-quiet'),
      row(
        'tool-1',
        { kind: 'tool-call', name: 'Read', input: { path: 'a.ts' }, state: 'completed' },
        'turn-quiet'
      ),
      row(
        'quiet-reply',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'NO_REPLY' }] },
        'turn-quiet'
      )
    ]
    expect(isQuietEmptyBotGroupMailTurn(makeTurn('q', { mailbox: true }), quietMailItems)).toBe(
      true
    )
    expect(isQuietEmptyBotGroupMailTurn(makeTurn('q'), quietMailItems)).toBe(false)
    expect(
      isQuietEmptyBotGroupMailTurn(
        makeTurn('q', { mailbox: true, answer: 'Replied by mail' }),
        quietMailItems
      )
    ).toBe(false)
    expect(
      isQuietEmptyBotGroupMailTurn(
        makeTurn('q', { mailbox: true, error: 'Failed' }),
        quietMailItems
      )
    ).toBe(false)

    const withItemNote = [
      completedTurn('turn-card'),
      row(
        'note-1',
        {
          kind: 'bot-item-note',
          noteId: 'note-1',
          by: 'bot',
          entries: [
            {
              uid: 'item-11',
              number: 11,
              title: 'Mob AI Tweaks',
              status: 'working',
              event: 'commented',
              text: 'Updated patch'
            }
          ]
        },
        'turn-card'
      ),
      row(
        'quiet-after-card',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'NO_REPLY' }] },
        'turn-card'
      )
    ]
    expect(isQuietEmptyBotGroupMailTurn(makeTurn('c', { mailbox: true }), withItemNote)).toBe(false)

    const runningItems = [
      row('turn-live', { kind: 'turn', turnId: 'turn-live', state: 'running', startedAt: 1 }),
      row(
        'partial',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'NO_REPLY' }] },
        'turn-live'
      )
    ]
    expect(isQuietEmptyBotGroupMailTurn(makeTurn('r', { mailbox: true }), runningItems)).toBe(false)

    const messages: BotGroupMessage[] = [
      {
        id: 'owner',
        groupId: 'g',
        sequence: 1,
        author: { kind: 'owner' },
        text: 'Check status',
        createdAt: 1,
        turns: []
      },
      {
        id: 'quiet-mail',
        groupId: 'g',
        sequence: 2,
        author: { kind: 'bot', id: 'bot-0', name: 'SPC' },
        text: 'SPC read reply',
        createdAt: 2,
        turns: [makeTurn('q', { mailbox: true, frozenItems: quietMailItems })]
      },
      {
        id: 'card-mail',
        groupId: 'g',
        sequence: 3,
        author: { kind: 'bot', id: 'bot-0', name: 'SPC' },
        text: 'Crawler told Patcher',
        createdAt: 3,
        turns: [makeTurn('c', { mailbox: true, frozenItems: withItemNote })]
      }
    ]
    expect(visibleBotGroupMessages(messages, new Map()).map((message) => message.id)).toEqual([
      'owner',
      'card-mail'
    ])
  })
})
