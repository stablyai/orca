import {
  CLAUDE_IDLE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING
} from './agent-title-glyphs'

// Jcode uses identity or conversation heads; only the final native duration reports activity.
const JCODE_TITLE_ACTIVITY_RE = /\s+\u00B7\s+(work|last)\s+~(?:\d+(?:\.\d+)?[dhms])+$/u
const JCODE_TITLE_EMOJI_RE = /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*/u
const JCODE_TITLE_DIFF_RE = /\s+\u00B7\s+\+\d+\s+-\d+$/u

export type JcodeDiffStat = { added: number; removed: number }

export function getJcodeTitleDiffStat(title: string | null | undefined): JcodeDiffStat | null {
  const match = title?.replace(JCODE_TITLE_ACTIVITY_RE, '').match(/\s+·\s+\+(\d+)\s+-(\d+)$/u)
  if (!match) {
    return null
  }
  const added = Number(match[1])
  const removed = Number(match[2])
  return Number.isSafeInteger(added) && Number.isSafeInteger(removed) ? { added, removed } : null
}

/** The jcode title with its per-session emoji and live diff/duration segments removed. */
export function stripJcodeTitleStatus(title: string): string {
  return title
    .replace(JCODE_TITLE_EMOJI_RE, '')
    .replace(JCODE_TITLE_ACTIVITY_RE, '')
    .replace(JCODE_TITLE_DIFF_RE, '')
    .trim()
}

// Explicit case matching keeps codenames capitalized; /<server> names the daemon.
const JCODE_IDENTITY_TITLE_RE =
  /^[jJ][cC][oO][dD][eE](?:\/[^\s\u00B7]+)?(?:\s+\p{Lu}[^\s\u00B7]*)?$/u
const FOREIGN_STATUS_GLYPHS = [
  CLAUDE_IDLE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING
]

/** True when a jcode title says only which jcode session this is, not what it is doing. */
export function isJcodeIdentityTerminalTitle(title: string | null | undefined): boolean {
  return (
    Boolean(title) &&
    !FOREIGN_STATUS_GLYPHS.some((glyph) => title?.trimStart().startsWith(glyph)) &&
    JCODE_IDENTITY_TITLE_RE.test(stripJcodeTitleStatus(title ?? ''))
  )
}

export function getJcodeTitleIdentity(title: string): 'jcode' | null {
  return isJcodeIdentityTerminalTitle(title) ? 'jcode' : null
}

export function getJcodeTerminalTitleActivity(title: string): 'work' | 'last' | null {
  const activity = JCODE_TITLE_ACTIVITY_RE.exec(title)?.[1]
  return activity === 'work' || activity === 'last' ? activity : null
}

/** Activity alone does not identify Jcode: conversation heads carry the same native tail. */
export function getJcodeTerminalTitleStatus(title: string): 'working' | 'idle' | null {
  const activity = getJcodeTerminalTitleActivity(title)
  return activity
    ? activity === 'work'
      ? 'working'
      : 'idle'
    : isJcodeIdentityTerminalTitle(title)
      ? 'idle'
      : null
}
