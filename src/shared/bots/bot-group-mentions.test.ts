import { describe, expect, it } from 'vitest'
import type { BotGroup } from './bot-group'
import {
  botGroupAudience,
  botGroupDraftAudience,
  botGroupMentionSegments,
  botGroupReplyMentions,
  botGroupSingleRecipient,
  botGroupReplyDraft,
  formatBotGroupAudience
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

describe('attached files', () => {
  it('reads a leading file reference as data, not an unknown bot', () => {
    const mentions = room({ kind: 'mentions' })
    expect(botGroupAudience('@/tmp/shot.avif @Sage what is this?', mentions, bots)).toEqual([
      'sage'
    ])
    expect(botGroupAudience('@"C:\\My Shots\\a.avif" hi', room({ kind: 'all' }), bots)).toEqual([
      'scout',
      'sage',
      'code-scout'
    ])
    expect(() => botGroupAudience('@Scuot hi', mentions, bots)).toThrow(/unavailable/)
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

  it('distinguishes @everyone from longer and ambiguous member names', () => {
    expect(botGroupAudience('@Everyone Helper review this', mentionsRoom, named)).toEqual([
      'helper'
    ])
    expect(botGroupAudience('@everyone review this', mentionsRoom, named)).toEqual([
      'helper',
      'other'
    ])

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

describe("a member's reply hand-offs", () => {
  const members = [...bots, { id: 'ops', name: 'Ops' }, { id: 'ops-lead', name: 'Ops Lead' }]
  const group = { members: members.map((bot) => ({ botId: bot.id, sessionId: bot.id })) }
  const wakes = (reply: string, speaker = 'speaker') =>
    botGroupReplyMentions(reply, group, members, speaker).map(({ id }) => id)

  it('wakes whole member names anywhere in the reply, case-insensitively, in order', () => {
    expect(wakes('Done. @sage can you check, then @SCOUT ship it?')).toEqual(['sage', 'scout'])
    expect(wakes("I agree with @Sage's plan (@Scout).")).toEqual(['sage', 'scout'])
  })

  it('never matches inside a longer word or an address', () => {
    expect(wakes('Page @Opsgenie, mail jo@sage.com or j.@Sage, see @Scouting')).toEqual([])
  })

  it('takes the longest name at an @', () => {
    expect(wakes('@Ops Lead please, not @Ops.')).toEqual(['ops-lead', 'ops'])
    expect(wakes('@Code Scout review')).toEqual(['code-scout'])
  })

  it('never wakes the speaker itself', () => {
    expect(wakes('@Sage and @Scout', 'sage')).toEqual(['scout'])
  })

  it('ignores quoted strings and quoted room history', () => {
    expect(
      wakes(
        'He said "@Sage go" and \u201c@Scout\u201d.\n<quoted_room_history>@Ops Lead</quoted_room_history>'
      )
    ).toEqual([])
  })

  it('says where each member is first named', () => {
    expect(botGroupReplyMentions('ok @Sage, @Sage again', group, members, 'x')).toEqual([
      { id: 'sage', start: 3 }
    ])
  })

  it('reaches no one for an ambiguous name or @everyone', () => {
    const twins = [...members, { id: 'sage-2', name: 'sage' }]
    const room = { members: twins.map((bot) => ({ botId: bot.id, sessionId: bot.id })) }
    expect(botGroupReplyMentions('@Sage and @everyone, @Scout', room, twins, 'x')).toEqual([
      { id: 'scout', start: 21 }
    ])
  })

  it('never lets an unknown name swallow the mention right after it', () => {
    expect(wakes('cc @Former,@Sage please review')).toEqual(['sage'])
  })

  it('reads @everyone with the same end as a name, so a member named Everyone stays ambiguous', () => {
    const everyone = [...members, { id: 'everyone', name: 'Everyone' }]
    const room = { members: everyone.map((bot) => ({ botId: bot.id, sessionId: bot.id })) }
    expect(botGroupReplyMentions('[@everyone] and @everyone', room, everyone, 'x')).toEqual([])
  })
})

describe('a member on another computer', () => {
  // Same bot id as a local member: only the host-qualified key tells them apart.
  const mixed = {
    ...room({ kind: 'bot', botId: 'scout' }),
    remoteMembers: [{ environmentId: 'ws', botId: 'scout', name: 'Willow' }]
  }
  const label = (draft: string, group = mixed) =>
    formatBotGroupAudience(
      botGroupDraftAudience(draft, group, bots),
      group,
      bots,
      (_k, fallback, values) => fallback.replace('{{count}}', String(values?.count ?? ''))
    )

  it('is reached by its mention or by everyone, never by the local default', () => {
    expect(botGroupAudience('hi', mixed, bots)).toEqual(['scout'])
    expect(botGroupAudience('@Willow hi', mixed, bots)).toEqual(['remote:ws:scout'])
    expect(botGroupAudience('@everyone hi', mixed, bots)).toEqual([
      'scout',
      'sage',
      'code-scout',
      'remote:ws:scout'
    ])
  })

  it('is named in the Replies label, and counted among all bots', () => {
    expect(label('@Willow hi')).toBe('Willow')
    expect(label('@everyone hi')).toBe('All bots · 4')
  })

  it("is never woken by another member's @Name reply", () => {
    expect(botGroupReplyMentions('@Willow and @Sage', mixed, bots, 'scout')).toEqual([
      { id: 'sage', start: 12 }
    ])
  })

  it('keeps its longer name from waking a local member whose name starts it', () => {
    const sageBot = {
      ...mixed,
      remoteMembers: [{ environmentId: 'ws', botId: 'sb', name: 'Sage Bot' }]
    }
    expect(botGroupReplyMentions('@Sage Bot can you check', sageBot, bots, 'scout')).toEqual([])
    expect(botGroupReplyMentions('@Sage can you check', sageBot, bots, 'scout')).toEqual([
      { id: 'sage', start: 0 }
    ])
  })
})
