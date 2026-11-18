import type { Bot } from '../bot-types'
import type { BotGroup } from './bot-group-schema'

type Room = Pick<BotGroup, 'members' | 'replyMode'>
type Named = Pick<Bot, 'id' | 'name'>

export type BotGroupMention = {
  start: number
  end: number
  /** Part of the address list the text opens with. */
  leading: boolean
  match: 'member' | 'everyone' | 'ambiguous' | 'none'
  ids: readonly string[]
}

const EVERYONE = '@everyone'
const MENTION_START = /(^|[^\p{L}\p{N}_.@])@/gu
const MENTION_END = /^(?:$|[\s,:;!?)]|\.(?:\s|$))/u
const LEADING_GAP = /^[\s,:!?]*$/u
// Code and quoted prose is data, never an address; blanked to keep every offset in place.
const UNADDRESSED_PROSE =
  /```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*`|^[ \t]*>.*$|\u201c[^\u201d]*\u201d|"[^"\n]*"/gmu

/** Every `@` in `text` that could address someone: the longest member name it spells, `@everyone`,
 *  or `none` with the unmatched `@word`. Send, draft and display all read mentions through this. */
export function botGroupMentions(
  text: string,
  members: readonly Named[],
  everyone: readonly string[]
): BotGroupMention[] {
  const mentions: BotGroupMention[] = []
  let leadingEnd: number | null = 0
  for (const found of text.matchAll(MENTION_START)) {
    const start = found.index + found[1].length
    // Matches never overlap: an `@` inside a name already matched is part of that name.
    if (start < (mentions.at(-1)?.end ?? 0)) {
      continue
    }
    const rest = text.slice(start)
    const leading: boolean = leadingEnd !== null && LEADING_GAP.test(text.slice(leadingEnd, start))
    const named = members.filter(
      (bot) =>
        rest.slice(1, 1 + bot.name.length).toLocaleLowerCase() === bot.name.toLocaleLowerCase() &&
        MENTION_END.test(rest.slice(1 + bot.name.length))
    )
    const longest = Math.max(0, ...named.map((bot) => bot.name.length))
    const best = named.filter((bot) => bot.name.length === longest)
    const broadcast = /^@everyone/iu.test(rest) && MENTION_END.test(rest.slice(EVERYONE.length))
    // A member name spelled here (`Everyone Helper`) wins; one named exactly `Everyone` is ambiguous.
    const clash = broadcast && longest === EVERYONE.length - 1
    const mention: BotGroupMention =
      broadcast && best.length === 0
        ? { start, end: start + EVERYONE.length, leading, match: 'everyone', ids: everyone }
        : best.length > 0
          ? {
              start,
              end: start + 1 + longest,
              leading,
              match: best.length > 1 || clash ? 'ambiguous' : 'member',
              ids: best.map((bot) => bot.id)
            }
          : {
              start,
              end: start + (/^@\S*/u.exec(rest)?.[0].length ?? 1),
              leading,
              match: 'none',
              ids: []
            }
    mentions.push(mention)
    leadingEnd = leading ? mention.end : null
  }
  return mentions
}

function roomMentions(text: string, group: Room, bots: readonly Named[]): BotGroupMention[] {
  return botGroupMentions(
    text.replace(UNADDRESSED_PROSE, (prose) => ' '.repeat(prose.length)),
    bots.filter((bot) => group.members.some((member) => member.botId === bot.id)),
    group.members.map((member) => member.botId)
  )
}

/** Who the room's reply mode reaches when no one is mentioned; a default that left reaches no one. */
function replyModeAudience(group: Room): string[] {
  const { replyMode } = group
  const members = group.members.map((member) => member.botId)
  return replyMode.kind === 'all'
    ? members
    : replyMode.kind === 'bot' && members.includes(replyMode.botId)
      ? [replyMode.botId]
      : []
}

const unique = (mentions: readonly BotGroupMention[]) => [
  ...new Set(mentions.flatMap((mention) => mention.ids))
]

/** `draft` prefixed to address `botId` by its current name; unchanged once it left the room, so an
 *  old turn's reply never reaches whoever now holds its historical name. */
export function botGroupReplyDraft(
  botId: string,
  draft: string,
  group: Room,
  bots: readonly Named[]
): string {
  const bot = group.members.some((member) => member.botId === botId)
    ? bots.find((candidate) => candidate.id === botId)
    : undefined
  return bot ? `@${bot.name} ${draft}` : draft
}

/** A leading address list must name members; a later member `@` also addresses it, and an unknown
 *  `@word` past the leading list stays plain text. */
export function botGroupAudience(text: string, group: Room, bots: readonly Named[]): string[] {
  const mentions = roomMentions(text, group, bots)
  if (mentions.some((mention) => mention.match === 'ambiguous')) {
    throw new Error('Correct the ambiguous bot mention before sending.')
  }
  if (mentions.some((mention) => mention.leading && mention.match === 'none')) {
    throw new Error('Correct the unavailable or ambiguous bot mention before sending.')
  }
  const targets = unique(mentions)
  if (targets.length > 0) {
    return targets
  }
  const fallback = replyModeAudience(group)
  if (group.replyMode.kind === 'bot' && fallback.length === 0) {
    throw new Error('Choose a current room member in Room replies.')
  }
  return fallback
}

/** Who a draft reaches; `addressed` once it mentions someone. A mention still being typed at the
 *  end reaches no one yet. */
export function botGroupDraftAudience(
  draft: string,
  group: Room,
  bots: readonly Named[]
): { ids: string[]; addressed: boolean } | 'invalid' {
  const mentions = roomMentions(draft, group, bots).filter(
    (mention) => !(mention.match === 'none' && mention.end === draft.length)
  )
  if (
    mentions.some(
      (mention) => mention.match === 'ambiguous' || (mention.leading && mention.match === 'none')
    )
  ) {
    return 'invalid'
  }
  const ids = unique(mentions)
  return ids.length > 0
    ? { ids, addressed: true }
    : { ids: replyModeAudience(group), addressed: false }
}

export type BotGroupLabelTranslate = (
  key: string,
  fallback: string,
  values?: { count: number }
) => string

/** The Replies control's words for a draft's audience, in the caller's language. */
export function formatBotGroupAudience(
  audience: ReturnType<typeof botGroupDraftAudience>,
  group: Room,
  bots: readonly Named[],
  t: BotGroupLabelTranslate
): string {
  if (audience === 'invalid') {
    return t('bots.groups.correctMention', 'Correct mention')
  }
  const { ids } = audience
  if (!audience.addressed && group.replyMode.kind === 'all') {
    return t('bots.groups.allBots', 'All bots')
  }
  if (ids.length === 0) {
    return t('bots.groups.onlyWhenMentioned', 'Only when mentioned')
  }
  if (ids.length === 1) {
    return (
      bots.find((bot) => bot.id === ids[0])?.name ??
      t('bots.groups.unavailableBot', 'Unavailable bot')
    )
  }
  return ids.length === group.members.length
    ? t('bots.groups.allBotsCount', 'All bots · {{count}}', { count: ids.length })
    : t('bots.groups.mentionedCount', '{{count}} mentioned', { count: ids.length })
}

/** The one bot a draft reaches, whose model and permissions the composer can show. */
export function botGroupSingleRecipient(
  draft: string,
  group: Room,
  bots: readonly Named[]
): string | null {
  const audience = botGroupDraftAudience(draft, group, bots)
  return audience !== 'invalid' && audience.ids.length === 1 ? audience.ids[0] : null
}

export type BotGroupMentionSegment = { text: string; mention: boolean }

/** Splits text at the `@Name` / `@everyone` mentions sending would read, quoted prose included;
 *  outside a group (`everyone` false) only the names. */
export function botGroupMentionSegments(
  text: string,
  names: readonly string[],
  everyone = true
): BotGroupMentionSegment[] {
  const named = names.filter((name) => name.length > 0).map((name) => ({ id: name, name }))
  const segments: BotGroupMentionSegment[] = []
  let cursor = 0
  for (const { start, end, match } of botGroupMentions(text, named, [])) {
    if (match === 'none' || (match === 'everyone' && !everyone)) {
      continue
    }
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), mention: false })
    }
    segments.push({ text: text.slice(start, end), mention: true })
    cursor = end
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), mention: false })
  }
  return segments
}
