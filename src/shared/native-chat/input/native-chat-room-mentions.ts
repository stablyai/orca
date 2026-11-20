import {
  buildContextualLocaleLowercaseIndex,
  type LocaleLowercaseIndex
} from '../../locale-lowercase-index'

/** A matched run in a name or detail, as UTF-16 offsets into the original text. */
export type NativeChatMentionHit = { start: number; length: number }

/** 0 is bare `@`; 1 the name equals the query; 2 the name starts with it; 3 a later name word does;
 *  4 only what the member is for matches. */
export type NativeChatMentionTier = 0 | 1 | 2 | 3 | 4

export type NativeChatRoomMemberMatch = {
  value: string
  name: string
  tier: NativeChatMentionTier
  nameHits: readonly NativeChatMentionHit[]
  detailHits: readonly NativeChatMentionHit[]
  /** Listed but not pickable (a paused bot). */
  unavailable: boolean
}

/** `recentKey` keys recency so a renamed bot keeps its place; the name stands in when absent. */
type RankableMember = {
  name: string
  key?: string
  recentKey?: string
  detail?: string
  unavailable?: string
}

type Word = LocaleLowercaseIndex & { start: number }

/** Space, `-`, `_`, `.`, `/` and any other punctuation split words. */
const WORD = /[\p{L}\p{N}\p{M}]+/gu
// Scripts written without spaces can't be split into words, so they fall back to substring matching.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const RECENT_SECTION = 3
// Joining a longer query to name words is never a real name, and bounds the backtracking.
const MAX_JOINED = 64

function wordsOf(text: string): Word[] {
  return Array.from(text.matchAll(WORD), (match) => ({
    ...buildContextualLocaleLowercaseIndex(match[0]),
    start: match.index
  }))
}

function originalHit(
  text: LocaleLowercaseIndex,
  start: number,
  length: number,
  offset = 0
): NativeChatMentionHit {
  const originalStart = text.originalStartByNormalizedOffset?.[start] ?? start
  const end = text.originalEndByNormalizedOffset?.[start + length - 1] ?? start + length
  return { start: offset + originalStart, length: end - originalStart }
}

function matchUnspaced(text: string, raw: string): NativeChatMentionHit | null {
  if (!UNSPACED_SCRIPT.test(raw)) {
    return null
  }
  const normalized = buildContextualLocaleLowercaseIndex(text)
  const index = normalized.text.indexOf(raw)
  return index === -1 ? null : originalHit(normalized, index, raw.length)
}

/** A–Z with punctuation folded to single spaces, so `Eng-Bot-Builder` sorts among `Eng - …`. */
function sortKey(name: string): string {
  return wordsOf(name)
    .map((word) => word.text)
    .join(' ')
}

/** Each query word starts a name word, in order. */
function matchWordStarts(words: readonly Word[], query: readonly string[]): number[] | null {
  const at: number[] = []
  let from = 0
  for (const part of query) {
    let found = -1
    for (let index = from; index < words.length; index++) {
      if (words[index].text.startsWith(part)) {
        found = index
        break
      }
    }
    if (found < 0) {
      return null
    }
    at.push(found)
    from = found + 1
  }
  return at
}

/** A run-together query (`engneil`) split across consecutive name words, each giving a prefix.
 *  Failed (word, offset) states are remembered, so a near-miss costs words × query length. */
function matchJoined(
  words: readonly Word[],
  compact: string
): { first: number; hits: NativeChatMentionHit[] } | null {
  if (compact.length === 0 || compact.length > MAX_JOINED) {
    return null
  }
  const failed = new Set<number>()
  const from = (index: number, offset: number): NativeChatMentionHit[] | null => {
    if (offset === compact.length) {
      return []
    }
    const word = words[index]
    const state = index * (compact.length + 1) + offset
    if (!word || failed.has(state)) {
      return null
    }
    let shared = 0
    while (
      shared < word.text.length &&
      offset + shared < compact.length &&
      word.text[shared] === compact[offset + shared]
    ) {
      shared++
    }
    for (let take = shared; take > 0; take--) {
      const tail = from(index + 1, offset + take)
      if (tail) {
        return [originalHit(word, 0, take, word.start), ...tail]
      }
    }
    failed.add(state)
    return null
  }
  for (let first = 0; first < words.length; first++) {
    const hits = from(first, 0)
    if (hits) {
      return { first, hits }
    }
  }
  return null
}

function matchName(
  name: string,
  query: readonly string[],
  compact: string,
  raw: string
): { tier: 1 | 2 | 3; hits: NativeChatMentionHit[] } | null {
  const words = wordsOf(name)
  const exact = words.map((word) => word.text).join('') === compact
  const at = matchWordStarts(words, query)
  if (at) {
    return {
      tier: exact ? 1 : at[0] === 0 ? 2 : 3,
      hits: at.map((index, position) =>
        originalHit(words[index], 0, query[position].length, words[index].start)
      )
    }
  }
  // Only a single query word may run together; typed boundaries (`eng ne il`) stay boundaries.
  const joined = query.length === 1 ? matchJoined(words, compact) : null
  if (joined) {
    return { tier: exact ? 1 : joined.first === 0 ? 2 : 3, hits: joined.hits }
  }
  const hit = matchUnspaced(name, raw)
  return hit
    ? { tier: hit.start === 0 ? (name.length === hit.length ? 1 : 2) : 3, hits: [hit] }
    : null
}

/** Every query word starts a distinct detail word, in any order; a 1–2 letter query must be a whole
 *  word, so `@pr` finds "(PR)" but not "product". */
function matchDetail(
  detail: string,
  query: readonly string[],
  compact: string,
  raw: string
): NativeChatMentionHit[] | null {
  const words = wordsOf(detail)
  const whole = compact.length < 3
  const fits = (part: string, word: Word): boolean =>
    whole ? word.text === part : word.text.startsWith(part)
  // Bipartite matching (augmenting paths), so `rev reviewing` finds "reviewing review" whatever the order.
  const partOfWord = new Map<number, number>()
  const assign = (part: number, seen: Set<number>): boolean => {
    for (let index = 0; index < words.length; index++) {
      if (seen.has(index) || !fits(query[part], words[index])) {
        continue
      }
      seen.add(index)
      const holder = partOfWord.get(index)
      if (holder === undefined || assign(holder, seen)) {
        partOfWord.set(index, part)
        return true
      }
    }
    return false
  }
  if (query.length > 0 && query.every((_, part) => assign(part, new Set()))) {
    return [...partOfWord]
      .map(([index, part]) => originalHit(words[index], 0, query[part].length, words[index].start))
      .sort((a, b) => a.start - b.start)
  }
  const hit = matchUnspaced(detail, raw)
  return hit ? [hit] : null
}

/** Whether a pickable member's name matches, the only thing that keeps a query with a space open. */
export function nativeChatRoomNameMatches(
  members: readonly RankableMember[],
  query: string
): boolean {
  const words = wordsOf(query).map((word) => word.text)
  const compact = words.join('')
  const raw = buildContextualLocaleLowercaseIndex(query.trim()).text
  // A finished name plus a space is message text; an unfinished one (`@eng `) still needs the list.
  if (
    /\s$/.test(query) &&
    members.some((member) => !member.unavailable && member.name.toLocaleLowerCase() === raw)
  ) {
    return false
  }
  return (
    compact.length > 0 &&
    members.some((member) => !member.unavailable && matchName(member.name, words, compact, raw))
  )
}

/** Members an `@` query lists, best first, and how many lead as "Recent".
 *
 *  Names match by word starts: `@eng n`, `@eng-n` and `@engn` all find "Eng - Neil". Tiers: the name
 *  equals the query, then starts with it, then a later word does; only when no pickable name
 *  matches, what each member is for. Within a tier the most recently mentioned (`recent`, member keys
 *  newest first) lead, then A–Z. Paused members always come last. Bare `@` lists up to three recent
 *  pickable members first, then everyone A–Z. */
export function rankNativeChatRoomMembers(
  members: readonly RankableMember[],
  query: string,
  recent: readonly string[] = []
): { matches: NativeChatRoomMemberMatch[]; recentCount: number } {
  const recencyOf = new Map(
    members.map((member) => {
      const index = recent.indexOf(member.recentKey ?? member.name)
      return [member.key ?? member.name, index === -1 ? recent.length : index]
    })
  )
  const recency = (name: string): number => recencyOf.get(name) ?? recent.length
  const keys = new Map(members.map((member) => [member.name, sortKey(member.name)]))
  const byName = (a: NativeChatRoomMemberMatch, b: NativeChatRoomMemberMatch): number =>
    (keys.get(a.name) ?? '').localeCompare(keys.get(b.name) ?? '')
  const order = (a: NativeChatRoomMemberMatch, b: NativeChatRoomMemberMatch): number =>
    Number(a.unavailable) - Number(b.unavailable) ||
    a.tier - b.tier ||
    recency(a.value) - recency(b.value) ||
    byName(a, b)

  const words = wordsOf(query).map((word) => word.text)
  const compact = words.join('')
  const raw = buildContextualLocaleLowercaseIndex(query.trim()).text
  const entry = (
    member: RankableMember,
    tier: NativeChatMentionTier,
    nameHits: readonly NativeChatMentionHit[] = [],
    detailHits: readonly NativeChatMentionHit[] = []
  ): NativeChatRoomMemberMatch => ({
    name: member.name,
    value: member.key ?? member.name,
    tier,
    nameHits,
    detailHits,
    unavailable: Boolean(member.unavailable)
  })

  if (raw.length === 0) {
    const leading = recent
      .map((key) =>
        members.find((member) => (member.recentKey ?? member.name) === key && !member.unavailable)
      )
      .filter((member): member is RankableMember => member !== undefined)
      .slice(0, RECENT_SECTION)
    const rest = members
      .filter((member) => !leading.includes(member))
      .map((member) => entry(member, 0))
      .sort((a, b) => Number(a.unavailable) - Number(b.unavailable) || byName(a, b))
    return {
      matches: [...leading.map((member) => entry(member, 0)), ...rest],
      recentCount: leading.length
    }
  }
  if (compact.length === 0 && !UNSPACED_SCRIPT.test(raw)) {
    return { matches: [], recentCount: 0 }
  }

  const named: NativeChatRoomMemberMatch[] = []
  for (const member of members) {
    const match = matchName(member.name, words, compact, raw)
    if (match) {
      named.push(entry(member, match.tier, match.hits))
    }
  }
  // A paused name match can't be picked, so it doesn't hide what pickable members are for.
  if (named.some((match) => !match.unavailable)) {
    return { matches: named.sort(order), recentCount: 0 }
  }
  const described: NativeChatRoomMemberMatch[] = []
  for (const member of members) {
    const hits =
      member.detail && !named.some((match) => match.value === (member.key ?? member.name))
        ? matchDetail(member.detail, words, compact, raw)
        : null
    if (hits) {
      described.push(entry(member, 4, [], hits))
    }
  }
  return { matches: [...named, ...described].sort(order), recentCount: 0 }
}

// One short lead-in word gives the hit context; a longer one would push it out of a narrow row.
const MAX_LEAD_IN = 12

/** A detail cut to start just before its first hit, so the hit stays visible. */
export function nativeChatMentionSnippet(
  detail: string,
  hits: readonly NativeChatMentionHit[]
): { text: string; hits: NativeChatMentionHit[]; clipped: boolean } {
  const first = hits.length > 0 ? Math.min(...hits.map((hit) => hit.start)) : 0
  const words = wordsOf(detail)
  const index = words.findLastIndex((word) => word.start <= first)
  const lead = index > 0 && words[index].start === first ? words[index - 1] : undefined
  const start = lead && lead.text.length <= MAX_LEAD_IN ? lead.start : first
  return {
    text: detail.slice(start),
    hits: hits.map((hit) => ({ start: hit.start - start, length: hit.length })),
    clipped: start > 0
  }
}
