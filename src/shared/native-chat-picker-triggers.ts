import type { NativeChatPickerItem } from './native-chat-picker-items'

// `/` is the composer's trigger for every agent. A draft-leading slash is the one
// that can dispatch; elsewhere the token starts after whitespace and its query
// stops at the next `/` so file paths stay prose.
export const LEADING_SLASH_TRIGGER = /^\/(\S*)$/
export const MID_PROMPT_SLASH_TRIGGER = /\s\/([^\s/]*)$/
// An agent whose skills carry their own sigil (Codex `$`) also opens its skills alone on it.
const SKILL_SIGIL_TRIGGER = /(?:^|\s)\$(\S*)$/
const COMMON_ENV_VARS = new Set(
  'PATH HOME USER SHELL PWD TMPDIR TEMP TMP LANG TERM XDG_CONFIG_HOME'.split(' ')
)

/** The query after a `$` skill sigil at the caret, or null when it reads as shell
 *  syntax (`$HOME`, `$5`, `$(pwd)`, `$?`), by the same rule as Codex's own composer. */
export function matchSkillSigil(before: string): string | null {
  const query = before.match(SKILL_SIGIL_TRIGGER)?.[1] ?? null
  // A bare `$` still opens the full list.
  if (!query) {
    return query
  }
  const name = query.match(/^[\w:-]*/)?.[0] ?? ''
  if (name === '' || name === '_' || /^[-\d]/.test(name)) {
    return null
  }
  // Why: a lowercase spelling stays a skill, so a skill named `home` still completes.
  return !/[a-z]/.test(name) && COMMON_ENV_VARS.has(name.toUpperCase()) ? null : query
}

/** Replaces the typed trigger token with the item's own token, which for a skill
 *  is the agent-native form whichever trigger opened the menu. */
export function applyPickerSuggestion(
  draft: string,
  caret: number,
  item: NativeChatPickerItem
): { draft: string; caret: number; insertedToken: string } {
  const before = draft.slice(0, caret)
  const after = draft.slice(caret)
  const slashMatch = before.match(LEADING_SLASH_TRIGGER) ?? before.match(MID_PROMPT_SLASH_TRIGGER)
  const query = slashMatch?.[1] ?? (item.kind === 'skill' ? matchSkillSigil(before) : null)
  if (query === null) {
    return { draft, caret, insertedToken: '' }
  }
  const tokenStart = before.length - query.length - 1
  const nextBefore = `${before.slice(0, tokenStart)}${item.token} `
  return { draft: nextBefore + after, caret: nextBefore.length, insertedToken: item.token }
}
