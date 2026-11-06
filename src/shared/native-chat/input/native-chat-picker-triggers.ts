import type { NativeChatPickerItem } from './native-chat-picker-items'

// `/` is the composer's trigger for every agent. A draft-leading slash is the one
// that can dispatch; elsewhere the token starts after whitespace and its query
// allows native `skill:` namespaces while ordinary file paths stay prose.
export const LEADING_SLASH_TRIGGER = /^\/(\S*)$/
export const MID_PROMPT_SLASH_TRIGGER = /\s\/(skill:\S*|[^\s/]*)$/
// An agent whose skills carry their own sigil (Codex `$`) also opens its skills alone on it.
const SKILL_SIGIL_TRIGGER = /(?:^|\s)\$(\S*)$/
const COMMON_ENV_VARS = new Set(
  'PATH HOME USER SHELL PWD TMPDIR TEMP TMP LANG TERM XDG_CONFIG_HOME'.split(' ')
)

/** Match caret $ skill queries, excluding shell forms ($HOME, $5, $(pwd), $?) as Codex does. */
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

/** Replace the trigger with the agent-native item token, regardless of which sigil opened the menu. */
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
