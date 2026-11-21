import { describe, expect, it } from 'vitest'
import {
  botPurposeSnippet,
  createBotSidebarSearchIndex,
  matchBotSearchText,
  splitBotSearchText
} from './bot-sidebar-search'

type Entry =
  | { kind: 'bot'; id: string; bot: { name: string; paused: boolean } }
  | { kind: 'group'; id: string; group: { name: string } }

const bot = (id: string, name: string, paused = false): Entry => ({
  kind: 'bot',
  id,
  bot: { name, paused }
})

function marked(text: string, query: string): string[] {
  const ranges = matchBotSearchText(text, query)
  return ranges
    ? splitBotSearchText(text, ranges)
        .filter((p) => p.marked)
        .map((p) => p.text)
    : []
}

describe('matchBotSearchText', () => {
  it('matches the whole query when a purpose search exceeds 200 characters', () => {
    const prefix = 'a'.repeat(200)
    expect(matchBotSearchText(prefix, `${prefix}z`)).toBeNull()
    expect(matchBotSearchText(`${prefix}z`, `${prefix}z`)).toEqual([{ start: 0, end: 201 }])
  })

  it('matches a substring anywhere, ignoring case', () => {
    expect(marked('Eng - Reviewer', 'VIEW')).toEqual(['view'])
    expect(matchBotSearchText('Triage bot', 'zz')).toBeNull()
  })

  it('ignores accents both ways and marks the accented source', () => {
    expect(marked('Éclair bot', 'ecl')).toEqual(['Écl'])
    expect(marked('eclair', 'écl')).toEqual(['ecl'])
    // A decomposed accent stays with its letter.
    expect(marked('Café helper', 'cafe')).toEqual(['Café'])
  })

  it('folds a final sigma like any sigma', () => {
    expect(matchBotSearchText('ΟΔΟΣ', 'οδος')).not.toBeNull()
  })

  it('keeps astral characters whole', () => {
    expect(marked('🤖 Bot Ops', 'bot')).toEqual(['Bot'])
  })

  it('matches words of the query as word starts in any order', () => {
    expect(marked('Eng - Reviewer', 'rev eng')).toEqual(['Eng', 'Rev'])
    expect(matchBotSearchText('Eng - Reviewer', 'view eng')).toBeNull()
  })
})

describe('createBotSidebarSearchIndex', () => {
  it('follows purpose arrivals, replacements and removal on the same list', () => {
    let purpose: string | null = null
    const entry = bot('late', 'Scout')
    const live = createBotSidebarSearchIndex({
      shown: [entry],
      all: [entry],
      purposeOf: () => purpose
    })
    expect(live('review').matches).toEqual([])
    purpose = 'Reviews releases'
    expect(live('review').matches.map((match) => match.entry.id)).toEqual(['late'])
    purpose = 'Writes docs'
    expect(live('review').matches).toEqual([])
    expect(live('docs').matches.map((match) => match.entry.id)).toEqual(['late'])
    purpose = null
    expect(live('docs').matches).toEqual([])
  })

  const purposes: Record<string, string> = {
    b: 'Reviews pull requests for the team',
    c: 'Answers nora about deploys'
  }
  const shown: Entry[] = [
    bot('a', 'Disk Space'),
    bot('b', 'Triage'),
    { kind: 'group', id: 'g', group: { name: 'Review room' } },
    bot('c', 'Reviewer')
  ]
  const search = createBotSidebarSearchIndex({
    shown,
    all: [...shown, bot('p', 'Paused reviewer', true)],
    purposeOf: (entry) => purposes[entry.id] ?? null
  })

  it('lists name matches in list order, then purpose-only matches', () => {
    const { matches } = search('review')
    expect(matches.map((m) => m.entry.id)).toEqual(['g', 'c', 'b'])
    expect(matches[2]!.purpose?.text).toBe(purposes.b)
    expect(matches[1]!.purpose).toBeNull()
  })

  it('counts hidden paused bots that match by name', () => {
    expect(search('review').hiddenPausedMatches).toBe(1)
    expect(search('disk').hiddenPausedMatches).toBe(0)
  })

  it('returns nothing for a blank query', () => {
    expect(search(' ')).toEqual({ matches: [], hiddenPausedMatches: 0 })
  })
})

describe('botPurposeSnippet', () => {
  it('keeps a purpose whose match is near the start', () => {
    const text = 'Reviews pull requests'
    expect(botPurposeSnippet(text, [{ start: 0, end: 7 }]).text).toBe(text)
  })

  it('starts a long purpose at a word shortly before its match', () => {
    const text = 'Keeps an eye on the nightly builds and tells the team about flaky tests'
    const start = text.indexOf('flaky')
    const snippet = botPurposeSnippet(text, [{ start, end: start + 5 }])
    expect(snippet.text.startsWith('…')).toBe(true)
    const [range] = snippet.ranges
    expect(snippet.text.slice(range!.start, range!.end)).toBe('flaky')
  })
})
