import { describe, expect, it } from 'vitest'
import type { BotGroup } from './bot-group'
import {
  botGroupAudience,
  botGroupDraftAudience,
  botGroupMentionSegments,
  botGroupSingleRecipient,
  botGroupReplyDraft
} from './bot-group-mentions'

const bots = [
  { id: 'scout', name: 'Scout' },
  { id: 'sage', name: 'Sage' },
  { id: 'code-scout', name: 'Code Scout' }
]
const room = (replyMode: BotGroup['replyMode']): Pick<BotGroup, 'members' | 'replyMode'> => ({
  replyMode,
  members: bots.map((bot) => ({ botId: bot.id, sessionId: bot.id }))
})

describe('group draft audience', () => {
  it('names the one bot whose options apply, only when exactly one would answer', () => {
    expect(botGroupSingleRecipient('hi', room({ kind: 'bot', botId: 'sage' }), bots)).toBe('sage')
    expect(botGroupSingleRecipient('hi', room({ kind: 'all' }), bots)).toBeNull()
    expect(botGroupSingleRecipient('hi', room({ kind: 'mentions' }), bots)).toBeNull()
    expect(botGroupSingleRecipient('@Scout hi', room({ kind: 'all' }), bots)).toBe('scout')
    expect(botGroupSingleRecipient('@Scout @Sage hi', room({ kind: 'mentions' }), bots)).toBeNull()
  })

  it('marks a draft addressed once it mentions someone, and resolves a complete name at the end', () => {
    expect(botGroupDraftAudience('@Sage hi', room({ kind: 'bot', botId: 'sage' }), bots)).toEqual({
      ids: ['sage'],
      addressed: true
    })
    expect(botGroupDraftAudience('@Scout', room({ kind: 'all' }), bots)).toEqual({
      ids: ['scout'],
      addressed: true
    })
    expect(botGroupDraftAudience('@Scout hi', room({ kind: 'all' }), bots)).toEqual({
      ids: ['scout'],
      addressed: true
    })
    expect(botGroupDraftAudience('@Nobody hi', room({ kind: 'all' }), bots)).toBe('invalid')
  })

  it('ignores a mention still being typed, so the label stays the reply mode', () => {
    for (const draft of ['@', '@Sc', 'thanks @No']) {
      expect(botGroupDraftAudience(draft, room({ kind: 'all' }), bots)).toEqual({
        ids: bots.map((bot) => bot.id),
        addressed: false
      })
    }
  })
})

describe('group mention segments', () => {
  const names = bots.map((bot) => bot.name)
  const mentions = (text: string) =>
    botGroupMentionSegments(text, names)
      .filter((segment) => segment.mention)
      .map((segment) => segment.text)

  it('finds member and everyone mentions anywhere, longest name first', () => {
    expect(mentions('@Code Scout and @scout, ask @everyone.')).toEqual([
      '@Code Scout',
      '@scout',
      '@everyone'
    ])
  })

  it('leaves emails, partial names and unknown handles as text', () => {
    expect(mentions('mail a@Scout.dev or @Scouting or @Nobody')).toEqual([])
    expect(mentions('@Scout; then @Sage.')).toEqual(['@Scout', '@Sage'])
    expect(
      botGroupMentionSegments('hi @Sage!', names)
        .map((segment) => segment.text)
        .join('')
    ).toBe('hi @Sage!')
  })
})

describe('non-overlapping mentions', () => {
  it('never reads an @ inside a matched name as a second mention', () => {
    const named = [
      { id: 'long', name: 'Scout @Sage' },
      { id: 'sage', name: 'Sage' }
    ]
    const group: Pick<BotGroup, 'members' | 'replyMode'> = {
      replyMode: { kind: 'mentions' },
      members: named.map((bot) => ({ botId: bot.id, sessionId: bot.id }))
    }
    expect(botGroupAudience('@Scout @Sage', group, named)).toEqual(['long'])
    const segments = botGroupMentionSegments(
      '@Scout @Sage',
      named.map((bot) => bot.name)
    )
    expect(segments.map((segment) => segment.text).join('')).toBe('@Scout @Sage')
    expect(segments).toEqual([{ text: '@Scout @Sage', mention: true }])
  })
})

describe('everyone-like member names', () => {
  const named = [
    { id: 'helper', name: 'Everyone Helper' },
    { id: 'other', name: 'Other' }
  ]
  const mentionsRoom = {
    replyMode: { kind: 'mentions' as const },
    members: named.map((bot) => ({ botId: bot.id, sessionId: bot.id }))
  }

  it('addresses a member whose name starts with Everyone, not the whole room', () => {
    expect(botGroupAudience('@Everyone Helper review this', mentionsRoom, named)).toEqual([
      'helper'
    ])
    expect(botGroupAudience('@everyone review this', mentionsRoom, named)).toEqual([
      'helper',
      'other'
    ])
  })

  it('refuses a member named exactly Everyone instead of broadcasting', () => {
    const exact = [{ id: 'everyone-bot', name: 'Everyone' }, named[1]]
    const exactRoom = {
      ...mentionsRoom,
      members: exact.map((bot) => ({ botId: bot.id, sessionId: bot.id }))
    }
    expect(() => botGroupAudience('@Everyone hi', exactRoom, exact)).toThrow('ambiguous')
  })
})

describe('reply to a turn', () => {
  it('addresses the bot by its current name, and never whoever took its old one', () => {
    const renamed = [
      { id: 'scout', name: 'Renamed' },
      { id: 'sage', name: 'Scout' }
    ]
    const group = room({ kind: 'mentions' })
    expect(botGroupReplyDraft('scout', 'please continue', group, renamed)).toBe(
      '@Renamed please continue'
    )
    expect(
      botGroupAudience(botGroupReplyDraft('scout', 'go', group, renamed), group, renamed)
    ).toEqual(['scout'])
    expect(botGroupReplyDraft('gone', 'please continue', group, renamed)).toBe('please continue')
  })
})
