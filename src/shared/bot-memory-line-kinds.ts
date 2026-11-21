// What a MEMORY.md line says it is, by its first word after the date ("Rule:", "Prefers:", …), and
// whether an untyped line still reads like a standing instruction from the owner.

export const BOT_MEMORY_KINDS = ['rule', 'preference', 'decision', 'lesson', 'fact'] as const
export type BotMemoryKind = (typeof BOT_MEMORY_KINDS)[number]

export const BOT_MEMORY_KIND_WORDS: Record<BotMemoryKind, string> = {
  rule: 'Rule',
  preference: 'Prefers',
  decision: 'Decided',
  lesson: 'Lesson',
  fact: 'Fact'
}

const KIND_OF_WORD = new Map<string, BotMemoryKind>(
  BOT_MEMORY_KINDS.map((kind) => [BOT_MEMORY_KIND_WORDS[kind].toLowerCase(), kind])
)

const KIND_PREFIX = /^(rule|prefers|decided|lesson|fact)(?:\s*\(([^()]{1,40})\))?\s*:\s*/i

/** A fact's kind and project scope from its leading word; null kind: an untyped (legacy) line. */
export function botMemoryLineKind(text: string): {
  kind: BotMemoryKind | null
  scope: string | null
} {
  const typed = KIND_PREFIX.exec(text.trim())
  return typed
    ? { kind: KIND_OF_WORD.get(typed[1].toLowerCase()) ?? null, scope: typed[2]?.trim() || null }
    : { kind: null, scope: null }
}

/** Kinds only the owner's own words may change or retire. */
export function isOwnerKind(kind: BotMemoryKind | null): boolean {
  return kind === 'rule' || kind === 'preference' || kind === 'decision'
}

const STANDING_WORDS =
  /\b(always|never|from now on|don['’]?t|do not|stop|must|only|instead of|use \S+ instead)\b/i

/** Words that make an instruction standing rather than one-off. */
export function hasStandingWords(text: string): boolean {
  return STANDING_WORDS.test(text)
}

const OWNER_RULE_MARKS =
  /\bowner rule\b|\bfrom now on\b|\bowner (?:said|says|wants|prefers|decided)\b/i

/** A line a status cleanup must never move: typed as the owner's, or marked as an owner rule. */
export function isOwnerRuleLine(text: string): boolean {
  return isOwnerKind(botMemoryLineKind(text).kind) || OWNER_RULE_MARKS.test(text)
}

/** A line consolidation may only change with the owner's words: the owner's kinds, or an untyped
 *  line that reads like a standing instruction until it is typed. */
export function isProtectedBotMemoryLine(text: string): boolean {
  const { kind } = botMemoryLineKind(text)
  return isOwnerRuleLine(text) || (kind === null && hasStandingWords(text))
}
