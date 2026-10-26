/**
 * "@Name" mention parsing shared by the room host and the room UI.
 *
 * Pure so both sides apply the same rule: the host picks who answers a message and the
 * renderer highlights the same spans. A name holds spaces and mixed case; matching is
 * case-insensitive and prefers the longest member name so "@新 Bot 2" never reads as
 * "@新 Bot". Code spans, fenced code and Markdown links are literal text, never calls.
 *
 * Modeled after DeepSeek-Bot's ds-bot/src/shared/mentions.js.
 */

export const ROOM_ALL_WORDS = ['all', 'everyone', '所有人', '全体'] as const

// A letter, digit, "_", "-" or a path character after a name means a longer word
// ("@Mi" in "@MiniMax"), and "/" or "\" or a "." that goes on into a word mean a path:
// "@docs/guide.md" must not call a member named Docs.
const NAME_GOES_ON = /^(?:[a-z0-9_\-/\\]|\.[a-z0-9_-])/i
// A letter, digit, "_", "." or "/" before "@" means an address ("a@b", "medium.com/@W").
const ADDRESS_BEFORE = /[a-z0-9_./]/i
// Code spans, fenced code and Markdown links, with or without a title, are literal text.
const LITERAL =
  /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g

export type RoomMentionable = { id: string; name: string }

export type RoomMentionSpan = {
  start: number
  end: number
  /** Set when the span calls one member. */
  member?: RoomMentionable
  /** Set when the span calls everyone. */
  all?: boolean
}

const overlaps = (spans: readonly { start: number; end: number }[], start: number, end: number) =>
  spans.some((span) => start < span.end && span.start < end)

const fitsAt = (text: string, at: number, word: string) =>
  text.slice(at, at + word.length).toLowerCase() === word.toLowerCase() &&
  !NAME_GOES_ON.test(text.slice(at + word.length))

/**
 * Every "@Name" and "@all"-word outside code, links and references, in document order.
 * `references` are labels already rendered into the text by another subsystem (for
 * example a quoted conversation); one occurrence per label is a reference, not a call.
 */
export function roomMentionSpans(
  text: string,
  members: readonly RoomMentionable[],
  options: { references?: readonly string[] } = {}
): RoomMentionSpan[] {
  const value = String(text ?? '')
  const skip: { start: number; end: number }[] = [
    ...[...value.matchAll(LITERAL)].map((m) => ({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length
    })),
    // Reference labels win over member names so "@K notes" is a citation, not a call.
    ...referenceSpans(value, options.references ?? [])
  ]
  const byLength = members
    .filter((member) => member.name)
    .slice()
    .sort((a, b) => b.name.length - a.name.length)
  const spans: RoomMentionSpan[] = []
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if (at > 0 && ADDRESS_BEFORE.test(value[at - 1])) {
      continue
    }
    // "@all" and friends: the leading word is checked before member names, so a member
    // named "all" is refused upstream and "@all" always fans out.
    const rest = value.slice(at + 1)
    let consumed = 0
    let isAll = false
    for (const word of ROOM_ALL_WORDS) {
      if (fitsAt(rest, 0, word)) {
        consumed = word.length
        isAll = true
        break
      }
    }
    let member: RoomMentionable | undefined
    if (!isAll) {
      member = byLength.find((m) => fitsAt(rest, 0, m.name))
      if (member) {
        consumed = member.name.length
      }
    }
    if (consumed === 0 && !isAll) {
      continue
    }
    const end = at + 1 + (isAll ? consumed : member ? member.name.length : 0)
    if (end <= at + 1) {
      continue
    }
    if (overlaps(skip, at, end)) {
      continue
    }
    if (isAll) {
      spans.push({ start: at, end, all: true })
    } else if (member) {
      spans.push({ start: at, end, member })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

function referenceSpans(text: string, labels: readonly string[]) {
  const spans: { start: number; end: number; label: string }[] = []
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    if (!label) {
      continue
    }
    const needle = `@${label}`
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      const end = at + needle.length
      if (
        (at > 0 && ADDRESS_BEFORE.test(text[at - 1])) ||
        NAME_GOES_ON.test(text.slice(end)) ||
        overlaps(spans, at, end)
      ) {
        continue
      }
      spans.push({ start: at, end, label })
      break
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** What a member may be named, so "@<name>" reads one way only. */
export function roomMemberNameProblem(name: string): string | undefined {
  const text = String(name ?? '').trim()
  if (text === '') {
    return 'A member needs a name'
  }
  if (/[@`\r\n]/.test(text)) {
    return 'A member name cannot contain @, ` or a line break'
  }
  if (ROOM_ALL_WORDS.some((word) => word === text.toLowerCase())) {
    return `"${text}" calls everyone in a group, so it cannot be a member name`
  }
  if (['user', 'you'].includes(text.toLowerCase())) {
    return `"${text}" stands for the user in a chat, so it cannot be a member name`
  }
  return undefined
}

/** Which members a text calls, in order; `all` means "@all"-word was present. */
export function roomMentionsIn(
  text: string,
  members: readonly RoomMentionable[],
  options: { references?: readonly string[]; speakerId?: string } = {}
): { all: boolean; found: RoomMentionable[] } {
  const found: RoomMentionable[] = []
  let all = false
  for (const span of roomMentionSpans(text, members, options)) {
    if (span.all) {
      all = true
    } else if (
      span.member &&
      span.member.id !== options.speakerId &&
      !found.some((m) => m.id === span.member!.id)
    ) {
      found.push(span.member)
    }
  }
  return { all, found }
}
