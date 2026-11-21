import { describe, expect, it } from 'vitest'
import { botGroupAudience } from './bot-group-mentions'
import {
  botGroupCompletedText,
  botGroupOperationAdmitted,
  botGroupContext,
  botGroupTurnItems,
  botGroupRoom,
  botGroupTurnReplyText,
  findBotGroupRoom,
  type BotGroup,
  type BotGroupMessage
} from './bot-group'
import type {
  AgentJournalSnapshot,
  AgentJournalRenderItem
} from '../agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
const bots = Array.from({ length: 8 }, (_, index) => ({
  id: `bot-${index}`,
  name: ['Scout', 'Forge', 'Sage', 'Ivy', 'Ash', 'Wren', 'Nova', 'Atlas'][index]
}))
const room = (replyMode: BotGroup['replyMode']): Pick<BotGroup, 'members' | 'replyMode'> => ({
  replyMode,
  members: bots.map((bot) => ({
    botId: bot.id,
    sessionId: `session:${bot.id}`
  }))
})

describe('group invocation audience', () => {
  it('uses room defaults until an explicit mention or @everyone overrides a send', () => {
    const group = room({ kind: 'bot', botId: 'bot-0' })
    expect(botGroupAudience('hello', group, bots)).toEqual(['bot-0'])
    expect(botGroupAudience('@Forge @Sage compare plans', group, bots)).toEqual(['bot-1', 'bot-2'])
    expect(botGroupAudience('next', group, bots)).toEqual(['bot-0'])
    expect(botGroupAudience('hello', room({ kind: 'mentions' }), bots)).toEqual([])
    expect(botGroupAudience('hello', room({ kind: 'all' }), bots)).toEqual(
      bots.map((bot) => bot.id)
    )
    expect(
      botGroupAudience('@everyone hello', room({ kind: 'mentions' }), [
        ...bots,
        { id: 'future', name: 'Future' }
      ])
    ).toEqual(bots.map((bot) => bot.id))
  })
  it('does not execute quoted, code or email prose as mentions', () => {
    for (const text of [
      '> @Forge hello',
      '`@Forge`',
      '```\n@Forge\n```',
      'foo@Forge.com',
      '“@Forge”',
      'say "@Forge" out loud'
    ]) {
      expect(botGroupAudience(text, room({ kind: 'all' }), bots)).toEqual(bots.map((bot) => bot.id))
    }
  })
  it('addresses a member mentioned anywhere in the prose, in every reply mode', () => {
    for (const mode of [
      { kind: 'mentions' },
      { kind: 'all' },
      { kind: 'bot', botId: 'bot-0' }
    ] as const) {
      expect(botGroupAudience('hey @Forge can you look', room(mode), bots)).toEqual(['bot-1'])
    }
    expect(
      botGroupAudience('@Sage and also @forge, thoughts?', room({ kind: 'mentions' }), bots)
    ).toEqual(['bot-2', 'bot-1'])
    expect(botGroupAudience('ping (@Ivy).', room({ kind: 'mentions' }), bots)).toEqual(['bot-3'])
  })
  it('keeps an unknown mid-sentence @word as plain text', () => {
    expect(
      botGroupAudience('mail me@example.com or ask @someone', room({ kind: 'mentions' }), bots)
    ).toEqual([])
    expect(
      botGroupAudience('cc @octocat please', room({ kind: 'bot', botId: 'bot-0' }), bots)
    ).toEqual(['bot-0'])
    expect(botGroupAudience('@Forge cc @octocat', room({ kind: 'mentions' }), bots)).toEqual([
      'bot-1'
    ])
  })
  it('prefers the longest member name over a shorter prefix', () => {
    const named = [...bots, { id: 'pro', name: 'Scout Pro' }]
    const group = {
      replyMode: { kind: 'mentions' as const },
      members: named.map((bot) => ({ botId: bot.id, sessionId: bot.id }))
    }
    expect(botGroupAudience('@Scout Pro review this', group, named)).toEqual(['pro'])
    expect(botGroupAudience('@Scout review this', group, named)).toEqual(['bot-0'])
    expect(botGroupAudience('then @scout pro, go', group, named)).toEqual(['pro'])
  })
  it('refuses removed, unknown, ambiguous and partial addresses without fallback', () => {
    const group = room({ kind: 'all' })
    for (const text of ['@Unknown help', '@Scou help', '@Scout @Unknown help']) {
      expect(() => botGroupAudience(text, group, bots)).toThrow(/mention/)
    }
    expect(() =>
      botGroupAudience('@Scout help', { ...group, members: group.members.slice(1) }, bots)
    ).toThrow(/mention/)
    expect(() =>
      botGroupAudience(
        '@Scout help',
        group,
        [...bots, { id: 'duplicate', name: 'Scout' }].map((bot) =>
          bot.id === 'duplicate' ? { ...bot, id: 'bot-1' } : bot
        )
      )
    ).toThrow(/ambiguous/)
  })
})

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
describe('native group publication', () => {
  it('joins only the host submission’s native turn, never another speaker or a later turn', () => {
    const promptId = agentJournalSubmissionKey('operation')
    const items = [
      row(promptId, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'instruction' }]
      }),
      row('turn', {
        kind: 'turn',
        turnId: 'provider-turn',
        state: 'completed',
        userItemId: promptId
      }),
      row(
        'answer',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'answer' }] },
        'turn'
      ),
      row(
        'other',
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'other' }] },
        'elsewhere'
      )
    ]
    const snapshot: AgentJournalSnapshot = {
      sessionId: 'session',
      cursor: { epoch: 'e', sequence: 1 },
      items,
      submissions: []
    }
    const own = botGroupTurnItems(snapshot, 'operation')
    expect(own.map((item) => item.itemId)).toEqual(['turn', 'answer'])
    expect(botGroupCompletedText(own)).toBe('answer')
    expect(
      botGroupCompletedText([
        row('turn', { kind: 'turn', turnId: 'provider-turn', state: 'running' }),
        items[2]
      ])
    ).toBeNull()
    expect(botGroupTurnItems(snapshot, 'unknown')).toEqual([])
  })
  it('uses Claude’s accepted provider identity when its user echo is absent', () => {
    const snapshot: AgentJournalSnapshot = {
      sessionId: 'claude-group',
      cursor: { epoch: 'e', sequence: 1 },
      submissions: [
        {
          clientMessageId: 'op',
          fence: 1,
          payloadFingerprint: 'f',
          dispatchState: 'accepted',
          providerItemId: 'claude-user',
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      ],
      items: [
        row(agentJournalSubmissionKey('op'), {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'host prompt' }]
        }),
        row('claude-turn', {
          kind: 'turn',
          turnId: 't',
          state: 'completed',
          userItemId: 'claude-user'
        }),
        row(
          'claude-answer',
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'real reply' }] },
          'claude-turn'
        )
      ]
    }
    expect(botGroupCompletedText(botGroupTurnItems(snapshot, 'op'))).toBe('real reply')
    expect(
      botGroupCompletedText(
        botGroupTurnItems(
          {
            ...snapshot,
            submissions: snapshot.submissions.map((submission) => ({
              ...submission,
              queuedMessageId: 'original-queued-operation'
            }))
          },
          'original-queued-operation'
        )
      )
    ).toBe('real reply')
    expect(botGroupTurnItems(snapshot, 'unrelated')).toEqual([])
  })
  it('bounds attributed quoted context, excluding unfinished answers and the invoked bot’s own output', () => {
    const messages: BotGroupMessage[] = [
      {
        id: 'request',
        groupId: 'group',
        sequence: 1,
        author: { kind: 'owner' },
        text: 'Human instruction',
        createdAt: 1,
        turns: [
          {
            botId: 'bot-0',
            botName: 'Scout',
            agent: 'claude',
            avatar: null,
            sessionId: 'session',
            operationId: 'a'
          },
          {
            botId: 'bot-1',
            botName: 'Forge',
            agent: 'codex',
            avatar: null,
            sessionId: 's2',
            operationId: 'b'
          }
        ]
      }
    ]
    const context = JSON.parse(
      botGroupContext(
        messages,
        new Map([
          ['a', 'own'],
          ['b', 'peer data']
        ]),
        { botId: 'bot-0', sessionId: 'joined-later' }
      )
    )
    expect(context).toEqual([
      { author: { kind: 'owner' }, text: 'Human instruction' },
      { author: { kind: 'bot', id: 'bot-1', name: 'Forge' }, text: 'peer data' }
    ])
    const member = { botId: 'bot-0', sessionId: 'session' }
    const oversized = [...messages, { ...messages[0], text: 'x'.repeat(100_000) }]
    expect(() => JSON.parse(botGroupContext(oversized, new Map(), member))).not.toThrow()
    expect(botGroupContext(oversized, new Map(), member).length).toBeLessThanOrEqual(24_000)
  })
  it('quotes only what a member has not seen since its last delivered turn', () => {
    const turn = (
      operationId: string,
      botId: string,
      sessionId: string
    ): BotGroupMessage['turns'][number] => ({
      operationId,
      botId,
      botName: botId,
      agent: 'claude',
      avatar: null,
      sessionId
    })
    const post = (sequence: number, turns: BotGroupMessage['turns']): BotGroupMessage => ({
      id: `m${sequence}`,
      groupId: 'group',
      sequence,
      author: { kind: 'owner' },
      text: `post ${sequence}`,
      createdAt: sequence,
      turns
    })
    const messages = [
      post(1, [turn('a1', 'bot-0', 'g0')]),
      post(2, [turn('a2', 'bot-0', 'g0'), turn('b2', 'bot-1', 'g1')]),
      post(3, [turn('b3', 'bot-1', 'g1')]),
      post(4, [{ ...turn('a4', 'bot-0', 'g0'), error: 'refused' }])
    ]
    const replies = new Map([
      ['a1', 'old own'],
      ['b2', 'parallel peer'],
      ['b3', 'later peer']
    ])
    expect(
      JSON.parse(botGroupContext(messages, replies, { botId: 'bot-0', sessionId: 'g0' }))
    ).toEqual([
      { author: { kind: 'bot', id: 'bot-1', name: 'bot-1' }, text: 'parallel peer' },
      { author: { kind: 'owner' }, text: 'post 3' },
      { author: { kind: 'bot', id: 'bot-1', name: 'bot-1' }, text: 'later peer' },
      { author: { kind: 'owner' }, text: 'post 4' }
    ])
    expect(
      JSON.parse(botGroupContext(messages, replies, { botId: 'bot-0', sessionId: 'fresh' }))
    ).toHaveLength(6)
  })
})

describe('operation resolution', () => {
  it('reads a queued operation through its latest attempt', () => {
    const attempt = (
      clientMessageId: string,
      accepted: boolean
    ): AgentJournalSnapshot['submissions'][number] => ({
      clientMessageId,
      queuedMessageId: 'queued-op',
      fence: 1,
      payloadFingerprint: 'f',
      dispatchState: accepted ? ('accepted' as const) : ('rejected' as const),
      providerItemId: accepted ? agentJournalSubmissionKey(clientMessageId) : null,
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    })
    const snapshot: AgentJournalSnapshot = {
      sessionId: 'session',
      cursor: { epoch: 'e', sequence: 3 },
      submissions: [attempt('try-1', false), attempt('try-2', true)],
      items: [
        row(agentJournalSubmissionKey('try-2'), {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'sent again' }]
        }),
        row('turn', {
          kind: 'turn',
          turnId: 't',
          state: 'completed',
          userItemId: agentJournalSubmissionKey('try-2')
        }),
        row(
          'reply',
          { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] },
          'turn'
        )
      ]
    }
    expect(botGroupOperationAdmitted(snapshot, 'queued-op')).toBe(true)
    expect(botGroupCompletedText(botGroupTurnItems(snapshot, 'queued-op'))).toBe('done')
  })
})

describe('group rooms', () => {
  const group: BotGroup = {
    id: 'g',
    name: 'Crew',
    hostId: 'local',
    revision: 1,
    folder: 'group-crew',
    folderWorkspaceId: 'fw-g',
    createdAt: 1,
    replyMode: { kind: 'mentions' },
    members: [{ botId: 'bot-0', sessionId: 'main-0' }],
    threads: [{ id: 't', createdAt: 1, members: [{ botId: 'bot-0', sessionId: 'thread-0' }] }]
  }

  it('resolves room tabs to the main or thread member sessions', () => {
    const main = findBotGroupRoom([group], 'g')
    const thread = findBotGroupRoom([group], 't')
    expect(main).toEqual({ group, threadId: undefined })
    expect(thread).toEqual({ group, threadId: 't' })
    expect(main && botGroupRoom(main.group, main.threadId).members[0]?.sessionId).toBe('main-0')
    expect(thread && botGroupRoom(thread.group, thread.threadId).members[0]?.sessionId).toBe(
      'thread-0'
    )
    expect(findBotGroupRoom([group], 'gone')).toBeNull()
    expect(() => botGroupRoom(group, 'gone')).toThrow(/no longer/)
  })
})

describe('a peer answer in the room history', () => {
  it('adds the answer once, as whole words, and drops a quiet marker', () => {
    expect(botGroupTurnReplyText('NO_REPLY', '42')).toBe('42')
    expect(botGroupTurnReplyText('Result: 42.', '42')).toBe('Result: 42.')
    expect(botGroupTurnReplyText('Processed 142 files.', '42')).toBe('Processed 142 files.\n\n42')
  })
})
