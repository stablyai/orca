import { deriveComposerAutocomplete } from './composer/native-chat-composer-autocomplete'
import { describe, expect, it } from 'vitest'
import {
  nativeChatMentionSnippet,
  nativeChatRoomNameMatches,
  rankNativeChatRoomMembers
} from './native-chat-room-mentions'

const BOTS = [
  { name: 'Bufo', detail: 'Bufo helps review and move open Orca pull requests (PR) forward.' },
  {
    name: 'UX Designer',
    detail: "I design Orca's UX and review user-visible engineering changes."
  },
  { name: 'CoS', detail: 'I find work and delegate it to the right bot.' },
  { name: 'Eng - Perf', detail: 'I drive Orca performance work forward.' },
  { name: 'Eng-Bot-Builder', detail: 'I am the engineer for the Orca Bot product.' },
  { name: 'Eng - Neil', detail: 'I own technical design and code review.' },
  { name: 'Eng - Jeff Dean', detail: 'I fix issues: root cause over patch.' },
  { name: 'Eng-Plugin', detail: "I build and maintain Orca's plugin system." },
  { name: 'Marketing - X-Manager', unavailable: 'Paused' },
  { name: 'Release Manager', detail: 'Release Manager keeps release notes accurate.' }
]

const names = (query: string, recent: string[] = []) =>
  rankNativeChatRoomMembers(BOTS, query, recent).matches.map((match) => match.name)

describe('rankNativeChatRoomMembers', () => {
  it('matches word starts only, never mid-word, so @eng leaves UX Designer out', () => {
    expect(names('eng')).toEqual([
      'Eng-Bot-Builder',
      'Eng - Jeff Dean',
      'Eng - Neil',
      'Eng - Perf',
      'Eng-Plugin'
    ])
    expect(names('ign')).toEqual([])
  })

  it('splits the query on space, dash, underscore, dot and slash', () => {
    for (const query of ['eng n', 'eng-n', 'eng_n', 'eng.n', 'eng/n']) {
      expect(names(query)).toEqual(['Eng - Neil'])
    }
    expect(names('eng-plugin')).toEqual(['Eng-Plugin'])
  })

  it('matches a run-together query across consecutive name words', () => {
    expect(names('engneil')).toEqual(['Eng - Neil'])
    expect(names('engn')).toEqual(['Eng - Neil'])
    expect(names('jeffdean')).toEqual(['Eng - Jeff Dean'])
    expect(names('engdean')).toEqual([])
  })

  it('keeps typed word boundaries: only a single query word runs together', () => {
    expect(names('eng ne il')).toEqual([])
    expect(names('eng ne')).toEqual(['Eng - Neil'])
  })

  it('rejects a long near-miss against many short name words', () => {
    const members = [{ name: Array.from({ length: 16 }, () => 'aaa').join(' ') }, { name: 'aab' }]
    expect(rankNativeChatRoomMembers(members, `${'a'.repeat(32)}b`).matches).toEqual([])
    expect(rankNativeChatRoomMembers(members, 'aaaaab').matches.map((match) => match.name)).toEqual(
      []
    )
    expect(rankNativeChatRoomMembers(members, 'aaaaaa').matches.map((match) => match.name)).toEqual(
      [members[0].name]
    )
  })

  it('assigns purpose words whatever order the query names them in', () => {
    const members = [{ name: 'Critic', detail: 'reviewing review' }]
    for (const query of ['rev reviewing', 'reviewing rev']) {
      expect(rankNativeChatRoomMembers(members, query).matches[0]?.detailHits).toEqual([
        { start: 0, length: 9 },
        { start: 10, length: 3 }
      ])
    }
  })

  it('ranks exact name, then name start, then a later name word', () => {
    const ranked = rankNativeChatRoomMembers(
      [{ name: 'Manager Bot' }, { name: 'Release Manager' }, { name: 'Manager' }],
      'manager'
    ).matches
    expect(ranked.map((match) => [match.name, match.tier])).toEqual([
      ['Manager', 1],
      ['Manager Bot', 2],
      ['Release Manager', 3]
    ])
    expect(names('cos')).toEqual(['CoS'])
    expect(names('ne')).toEqual(['Eng - Neil'])
  })

  it('falls back to what a bot is for only when no name matches', () => {
    expect(names('review')).toEqual(['Bufo', 'Eng - Neil', 'UX Designer'])
    expect(names('re')).toEqual(['Release Manager'])
  })

  it('needs a 1–2 letter purpose query to equal a whole word', () => {
    expect(names('pr')).toEqual(['Bufo'])
    expect(names('ow')).toEqual([])
  })

  it('puts the most recently mentioned first within a tier, without crossing tiers', () => {
    expect(names('eng', ['Eng - Perf', 'Eng - Neil'])).toEqual([
      'Eng - Perf',
      'Eng - Neil',
      'Eng-Bot-Builder',
      'Eng - Jeff Dean',
      'Eng-Plugin'
    ])
    const ranked = rankNativeChatRoomMembers(
      [{ name: 'Release Manager' }, { name: 'Manager' }],
      'manager',
      ['Release Manager']
    ).matches
    expect(ranked.map((match) => match.name)).toEqual(['Manager', 'Release Manager'])
  })

  it('sorts A–Z with punctuation folded, so Eng-Bot-Builder sits among the Eng bots', () => {
    const ranked = rankNativeChatRoomMembers(
      [{ name: 'Eng - Perf' }, { name: 'Eng-Bot-Builder' }, { name: 'Eng - Agent' }],
      'eng'
    ).matches
    expect(ranked.map((match) => match.name)).toEqual([
      'Eng - Agent',
      'Eng-Bot-Builder',
      'Eng - Perf'
    ])
  })

  it('lists paused bots last, even above-tier ones', () => {
    const members = [{ name: 'Marketing', unavailable: 'Paused' }, { name: 'VP of Marketing' }]
    const ranked = rankNativeChatRoomMembers(members, 'marketing').matches
    expect(ranked.map((match) => [match.name, match.unavailable])).toEqual([
      ['VP of Marketing', false],
      ['Marketing', true]
    ])
  })

  it("falls back to purpose when only a paused bot's name matches", () => {
    const members = [
      { name: 'Growth Bot', unavailable: 'Paused' },
      { name: 'VP of Marketing', detail: 'Launch posts, community and growth.' }
    ]
    const ranked = rankNativeChatRoomMembers(members, 'growth').matches
    expect(ranked.map((match) => [match.name, match.tier])).toEqual([
      ['VP of Marketing', 4],
      ['Growth Bot', 2]
    ])
    expect(nativeChatRoomNameMatches(members, 'growth')).toBe(false)
  })

  it('keys recency by member key, so a renamed bot keeps its place', () => {
    const members = [
      { name: 'Eng - Perf', recentKey: 'perf' },
      { name: 'Eng - Speed', recentKey: 'neil' }
    ]
    expect(
      rankNativeChatRoomMembers(members, 'eng', ['neil']).matches.map((match) => match.name)
    ).toEqual(['Eng - Speed', 'Eng - Perf'])
  })

  it('leads bare @ with up to three recent pickable bots, then everyone A–Z, paused last', () => {
    const { matches, recentCount } = rankNativeChatRoomMembers(BOTS, '', [
      'Marketing - X-Manager',
      'Eng - Neil',
      'CoS',
      'Bufo',
      'Eng-Plugin'
    ])
    expect(recentCount).toBe(3)
    expect(matches.map((match) => match.name)).toEqual([
      'Eng - Neil',
      'CoS',
      'Bufo',
      'Eng-Bot-Builder',
      'Eng - Jeff Dean',
      'Eng - Perf',
      'Eng-Plugin',
      'Release Manager',
      'UX Designer',
      'Marketing - X-Manager'
    ])
  })

  it('reports the matched word starts for bolding', () => {
    const [neil] = rankNativeChatRoomMembers(BOTS, 'eng n').matches
    expect(neil.nameHits).toEqual([
      { start: 0, length: 3 },
      { start: 6, length: 1 }
    ])
    const [bufo] = rankNativeChatRoomMembers(BOTS, 'pr').matches
    expect(bufo.detailHits).toEqual([{ start: 52, length: 2 }])
  })

  it('finds an apostrophized name from its unpunctuated spelling', () => {
    expect(rankNativeChatRoomMembers([{ name: 'O’Dell' }], 'odell').matches[0]?.nameHits).toEqual([
      { start: 0, length: 1 },
      { start: 2, length: 4 }
    ])
  })

  it('preserves contextual Greek lowercase matching and spaced query capture', () => {
    expect(rankNativeChatRoomMembers([{ name: 'ΝΙΚΟΣ' }], 'νικος').matches[0]?.nameHits).toEqual([
      { start: 0, length: 5 }
    ])
    expect(rankNativeChatRoomMembers([{ name: 'Νίκος' }], 'ΝΊΚΟΣ').matches[0]?.nameHits).toEqual([
      { start: 0, length: 5 }
    ])
    for (const [detail, query, length] of [
      ['ΕΛΕΓΧΟΣ', 'ελεγχος', 7],
      ['ΟΣ', 'ος', 2]
    ] as const) {
      expect(
        rankNativeChatRoomMembers([{ name: 'Critic', detail }], query).matches[0]?.detailHits
      ).toEqual([{ start: 0, length }])
    }
    expect(
      rankNativeChatRoomMembers([{ name: 'ΟΣ审查员' }], 'ος审查').matches[0]?.nameHits
    ).toEqual([{ start: 0, length: 4 }])
    expect(
      rankNativeChatRoomMembers([{ name: 'İΟΣ审查员' }], 'i̇ος审查').matches[0]?.nameHits
    ).toEqual([{ start: 0, length: 5 }])
    expect(
      deriveComposerAutocomplete(
        '@ος b',
        5,
        [],
        [],
        null,
        undefined,
        null,
        undefined,
        undefined,
        (query) => nativeChatRoomNameMatches([{ name: 'ΟΣ Bot' }], query)
      )
    ).toEqual({ mode: 'mention', query: 'ος b', triggerKey: '@:0' })
  })

  it('maps folded matches to original UTF-16 offsets without changing ASCII or CJK hits', () => {
    const [critic] = rankNativeChatRoomMembers(
      [{ name: 'Critic', detail: 'İ审查' }],
      '审查'
    ).matches
    expect(critic.detailHits).toEqual([{ start: 1, length: 2 }])
    expect(nativeChatMentionSnippet('İ审查', critic.detailHits)).toEqual({
      text: '审查',
      hits: [{ start: 0, length: 2 }],
      clipped: true
    })
    expect(rankNativeChatRoomMembers([{ name: 'İ审查员' }], '审查').matches[0]?.nameHits).toEqual([
      { start: 1, length: 2 }
    ])
    expect(rankNativeChatRoomMembers([{ name: 'İnci' }], 'İn').matches[0]?.nameHits).toEqual([
      { start: 0, length: 2 }
    ])
    expect(rankNativeChatRoomMembers([{ name: 'İnci Bot' }], 'İnb').matches[0]?.nameHits).toEqual([
      { start: 0, length: 2 },
      { start: 5, length: 1 }
    ])
    expect(
      rankNativeChatRoomMembers([{ name: 'Critic', detail: 'İnci' }], 'İn').matches[0]?.detailHits
    ).toEqual([{ start: 0, length: 2 }])
    expect(
      rankNativeChatRoomMembers([{ name: 'Critic', detail: 'CODE review' }], 'rev').matches[0]
        ?.detailHits
    ).toEqual([{ start: 5, length: 3 }])
    expect(
      rankNativeChatRoomMembers([{ name: 'Critic', detail: '代码审查' }], '审查').matches[0]
        ?.detailHits
    ).toEqual([{ start: 2, length: 2 }])
  })

  it('substring-matches scripts written without spaces', () => {
    const members = [{ name: '代码审查员' }, { name: '发布经理', detail: '负责整理发布说明' }]
    expect(rankNativeChatRoomMembers(members, '审查').matches.map((match) => match.name)).toEqual([
      '代码审查员'
    ])
    expect(rankNativeChatRoomMembers(members, '说明').matches.map((match) => match.name)).toEqual([
      '发布经理'
    ])
  })
})

describe('nativeChatRoomNameMatches', () => {
  it('holds a spaced query open only while a pickable name matches', () => {
    expect(nativeChatRoomNameMatches(BOTS, 'eng n')).toBe(true)
    expect(nativeChatRoomNameMatches(BOTS, 'neil please')).toBe(false)
    expect(nativeChatRoomNameMatches(BOTS, 'marketing x')).toBe(false)
  })
})

describe('nativeChatMentionSnippet', () => {
  it('retains a hit inside a CJK run with offsets into the visible snippet', () => {
    expect(
      nativeChatMentionSnippet('负责整理团队所有日常代码审查和发布说明 documentation', [
        { start: 12, length: 2 }
      ])
    ).toEqual({
      text: '审查和发布说明 documentation',
      hits: [{ start: 0, length: 2 }],
      clipped: true
    })
  })

  it('leads with one short word before the hit', () => {
    const detail = 'I own technical design and code review.'
    expect(nativeChatMentionSnippet(detail, [{ start: 32, length: 6 }])).toEqual({
      text: 'code review.',
      hits: [{ start: 5, length: 6 }],
      clipped: true
    })
  })

  it('starts at the hit when the word before it is long', () => {
    const detail = 'Keeps internationalization growth steady.'
    expect(nativeChatMentionSnippet(detail, [{ start: 27, length: 6 }])).toEqual({
      text: 'growth steady.',
      hits: [{ start: 0, length: 6 }],
      clipped: true
    })
  })
})

it('keeps picks of identically named bots on different computers separate', () => {
  const bots = [
    { name: 'Release Notes', key: 'local:release', recentKey: 'local:release' },
    { name: 'Release Notes', key: 'paired:release', recentKey: 'paired:release' }
  ]
  const recent = ['paired:release']
  expect(rankNativeChatRoomMembers(bots, '', recent).matches.map((hit) => hit.value)).toEqual([
    'paired:release',
    'local:release'
  ])
  expect(rankNativeChatRoomMembers(bots, 'rel n', recent).matches.map((hit) => hit.value)).toEqual([
    'paired:release',
    'local:release'
  ])
})

it('matches names across a separator and selects a later word on a paired bot', () => {
  const members = ['Eng - Perf', 'Eng - Reviewer', 'Eng - Reviewer - Official'].map((name) => ({
    name
  }))
  const matches = (query: string) =>
    rankNativeChatRoomMembers(members, query).matches.map((row) => row.name)
  expect(matches('eng-rev')).toEqual(['Eng - Reviewer', 'Eng - Reviewer - Official'])
  expect(matches('reviewer-off')).toEqual(['Eng - Reviewer - Official'])
})
