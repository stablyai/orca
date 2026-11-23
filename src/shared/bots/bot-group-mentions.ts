import type { Bot } from '../bot-types'
import { replaceImageReferences } from '../native-chat/attachments/native-chat-image-reference'
import { NATIVE_CHAT_QUOTED_FILE_REFERENCE } from '../native-chat/input/composer/agent-image-paste'
import type { BotGroup, BotGroupRemoteMember } from './bot-group-schema'
import { BotFailureError } from './bot-failure-copy'

type Room = Pick<BotGroup, 'members' | 'replyMode'> & {
  remoteMembers?: readonly Pick<BotGroupRemoteMember, 'environmentId' | 'botId' | 'name'>[]
}
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
// A member's reply addresses `@Name` wherever the name is not run into more word characters.
const REPLY_MENTION_END = /^(?![\p{L}\p{N}_])/u
const QUOTED_ROOM_HISTORY = /<quoted_room_history>[\s\S]*?(?:<\/quoted_room_history>|(?![\s\S]))/gu
// A parsed reply's code and block quotes come blanked already; its quoted strings stay data.
const QUOTED_STRINGS = /\u201c[^\u201d]*\u201d|"[^"\n]*"/gu
// Code and quoted prose is data, never an address; blanked to keep every offset in place.
const UNADDRESSED_PROSE =
  /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|`[^`\n]*`|^[ \t]*>.*$|\u201c[^\u201d]*\u201d|"[^"\n]*"/gmu
// A file's `@path`, as drops and attachments write it, is data too: quoted, or rooted at a path.
const FILE_REFERENCE = new RegExp(
  `${NATIVE_CHAT_QUOTED_FILE_REFERENCE.source}|@(?:[\\\\/~]|[a-z]:[\\\\/])\\S*`,
  'giu'
)

/** Every `@` in `text` that could address someone: the longest member name it spells, `@everyone`,
 *  or `none` with the unmatched `@word`. Send, draft and display all read mentions through this. */
export function botGroupMentions(
  text: string,
  members: readonly Named[],
  everyone: readonly string[],
  nameEnd = MENTION_END
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
        nameEnd.test(rest.slice(1 + bot.name.length))
    )
    const longest = Math.max(0, ...named.map((bot) => bot.name.length))
    const best = named.filter((bot) => bot.name.length === longest)
    const broadcast = /^@everyone/iu.test(rest) && nameEnd.test(rest.slice(EVERYONE.length))
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
              // Up to the next `@`, so an unknown name never swallows a mention right after it.
              end: start + (/^@[^\s@]*/u.exec(rest)?.[0].length ?? 1),
              leading,
              match: 'none',
              ids: []
            }
    mentions.push(mention)
    leadingEnd = leading ? mention.end : null
  }
  return mentions
}

/** A remote member's id in mentions and audiences (as `botGroupRemoteKey`): bot ids are unique only
 *  per computer, so a remote one never collides with a local id. */
export function remoteMemberKey(member: Pick<BotGroupRemoteMember, 'environmentId' | 'botId'>) {
  return `remote:${member.environmentId}:${member.botId}`
}

type RoomRoster = Pick<Room, 'members' | 'remoteMembers'>

/** The room's members as mentions name them: local bots by id, remote ones by their key. */
function roomNamed(group: RoomRoster, bots: readonly Named[]): Named[] {
  return [
    ...bots.filter((bot) => group.members.some((member) => member.botId === bot.id)),
    ...(group.remoteMembers ?? []).map((member) => ({
      id: remoteMemberKey(member),
      name: member.name
    }))
  ]
}

function roomMemberIds(group: RoomRoster): string[] {
  return [
    ...group.members.map((member) => member.botId),
    ...(group.remoteMembers ?? []).map(remoteMemberKey)
  ]
}

function roomMentions(
  text: string,
  group: RoomRoster,
  bots: readonly Named[],
  nameEnd?: RegExp,
  unaddressed = UNADDRESSED_PROSE
): BotGroupMention[] {
  return botGroupMentions(
    text
      .replace(FILE_REFERENCE, (file) => ' '.repeat(file.length))
      .replace(unaddressed, (prose) => ' '.repeat(prose.length)),
    roomNamed(group, bots),
    roomMemberIds(group),
    nameEnd
  )
}

/** The other members a member's reply hands off to, each with where it is first named: every
 *  `@Name` outside quoted strings and quoted history, in order. `prose` already has its Markdown
 *  code and block quotes blanked in place. `@everyone` and an ambiguous name reach no one; the
 *  speaker never itself. */
export function botGroupReplyMentions(
  prose: string,
  group: RoomRoster,
  bots: readonly Named[],
  speakerId: string
): { id: string; start: number }[] {
  const unquoted = prose.replace(QUOTED_ROOM_HISTORY, (quoted) => ' '.repeat(quoted.length))
  const named = new Map<string, number>()
  // Names are matched against the whole room, so "@Sage Bot" never wakes a local "Sage"; but a
  // hand-off wakes only this computer's members: a remote member is never asked by another bot.
  const local = new Set(group.members.map((member) => member.botId))
  for (const mention of roomMentions(unquoted, group, bots, REPLY_MENTION_END, QUOTED_STRINGS)) {
    const [id] = mention.ids
    if (
      mention.match === 'member' &&
      id !== undefined &&
      local.has(id) &&
      id !== speakerId &&
      !named.has(id)
    ) {
      named.set(id, mention.start)
    }
  }
  return [...named].map(([id, start]) => ({ id, start }))
}

/** Who the room's reply mode reaches when no one is mentioned; a default that left reaches no one. */
function replyModeAudience(group: Room): string[] {
  const { replyMode } = group
  const members = roomMemberIds(group)
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
    throw new BotFailureError('groupMentionAmbiguous')
  }
  if (mentions.some((mention) => mention.leading && mention.match === 'none')) {
    throw new BotFailureError('groupMentionUnavailable')
  }
  const targets = unique(mentions)
  if (targets.length > 0) {
    return targets
  }
  const fallback = replyModeAudience(group)
  if (group.replyMode.kind === 'bot' && fallback.length === 0) {
    throw new BotFailureError('groupReplierNotMember')
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
  const prose = replaceImageReferences(draft, () => '')
  const mentions = roomMentions(prose, group, bots).filter(
    (mention) => !(mention.match === 'none' && mention.end === prose.length)
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
    // A remote member is named by its key, so it is found among the room's members, not this
    // computer's bots.
    return (
      roomNamed(group, bots).find((bot) => bot.id === ids[0])?.name ??
      t('bots.groups.unavailableBot', 'Unavailable bot')
    )
  }
  return ids.length === roomMemberIds(group).length
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
