// Summarize categories in first-use order using the same vocabulary as glyphs so headers and icons agree.

import {
  nativeChatToolCategory,
  type NativeChatToolCategory,
  type NativeChatToolCategoryCall
} from './native-chat-tool-icon'
import { toolInputCommand } from './native-chat-tool-summary'
import { isToolCallBlock, type NativeChatBlock } from '../../native-chat-types'

/** Shared singular/plural category copy; desktop translates and mobile formats directly. */
export const NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY: Record<
  NativeChatToolCategory,
  { one: string; many: string }
> = {
  read: { one: 'Read 1 file', many: 'Read {{value0}} files' },
  search: { one: 'Searched 1 time', many: 'Searched {{value0}} times' },
  listFiles: { one: 'Listed 1 directory', many: 'Listed {{value0}} directories' },
  unknown: { one: 'Ran 1 command', many: 'Ran {{value0}} commands' },
  fileChange: { one: 'Edited 1 file', many: 'Edited {{value0}} files' },
  webSearch: { one: 'Searched the web 1 time', many: 'Searched the web {{value0}} times' },
  browser: { one: 'Used the browser', many: 'Used the browser {{value0}} times' },
  mcpToolCall: { one: 'Used 1 integration', many: 'Used {{value0}} integrations' },
  subAgentActivity: { one: 'Ran 1 agent', many: 'Ran {{value0}} agents' },
  todoList: { one: 'Updated the plan', many: 'Updated the plan {{value0}} times' },
  other: { one: 'Used 1 tool', many: 'Used {{value0}} tools' }
}

/** Live clauses mirror settled shape so status updates change text in place. */
export const NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY: Record<
  NativeChatToolCategory,
  { one: string; many: string }
> = {
  read: { one: 'Reading 1 file', many: 'Reading {{value0}} files' },
  search: { one: 'Searching 1 time', many: 'Searching {{value0}} times' },
  listFiles: { one: 'Listing 1 directory', many: 'Listing {{value0}} directories' },
  unknown: { one: 'Running 1 command', many: 'Running {{value0}} commands' },
  fileChange: { one: 'Editing 1 file', many: 'Editing {{value0}} files' },
  webSearch: { one: 'Searching the web 1 time', many: 'Searching the web {{value0}} times' },
  browser: { one: 'Using the browser', many: 'Using the browser {{value0}} times' },
  mcpToolCall: { one: 'Using 1 integration', many: 'Using {{value0}} integrations' },
  subAgentActivity: { one: 'Running 1 agent', many: 'Running {{value0}} agents' },
  todoList: { one: 'Updating the plan', many: 'Updating the plan {{value0}} times' },
  other: { one: 'Using 1 tool', many: 'Using {{value0}} tools' }
}

export const NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS = {
  /** Exactly two clauses. */
  pair: '{{value0}} and {{value1}}',
  /** Three or more: everything but the last, joined by separator, then the last. */
  list: '{{value0}}, and {{value1}}',
  separator: ', '
} as const

export type NativeChatToolRunClause = {
  category: NativeChatToolCategory
  count: number
}

/** Count categories in first-use order so the sentence follows the work, not count ranking. */
export function nativeChatToolRunClauses(
  calls: readonly NativeChatToolCategoryCall[]
): NativeChatToolRunClause[] {
  const counts = new Map<NativeChatToolCategory, number>()
  for (const call of calls) {
    const category = nativeChatToolCategory(call.name, call.mcpIdentity, call.input) ?? 'other'
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts].map(([category, count]) => ({ category, count }))
}

/** Capitalize only the first clause; locale-lowercase later first characters while preserving internal acronyms. */
export function joinNativeChatToolRunClauses(
  clauses: readonly string[],
  format: {
    pair: (first: string, second: string) => string
    list: (leading: readonly string[], last: string) => string
  }
): string {
  const continued = clauses.map((clause, index) =>
    index === 0 || clause.length === 0
      ? clause
      : `${clause[0].toLocaleLowerCase()}${clause.slice(1)}`
  )
  if (continued.length === 0) {
    return ''
  }
  if (continued.length === 1) {
    return continued[0]
  }
  if (continued.length === 2) {
    return format.pair(continued[0], continued[1])
  }
  return format.list(continued.slice(0, -1), continued.at(-1) ?? '')
}

export type NativeChatToolRunSentenceWords = {
  clause: (category: NativeChatToolCategory, count: number, live: boolean) => string
  pair: (first: string, second: string) => string
  list: (leading: readonly string[], last: string) => string
}

/** The one line a run reads as: past tense once settled, present while live. */
export function nativeChatToolRunSentence(
  blocks: readonly NativeChatBlock[],
  { live = false }: { live?: boolean },
  words: NativeChatToolRunSentenceWords
): string | null {
  const calls = blocks.filter(isToolCallBlock)
  if (calls.length === 0) {
    return null
  }
  // Settled lone shell calls show their command instead of Ran 1 command. While live, commands stay in the adjacent preview;
  // keep header shape stable when another call arrives.
  if (calls.length === 1 && !live) {
    const command = toolInputCommand(calls[0].input)
    if (command !== null && command.length > 0) {
      return command
    }
  }
  return joinNativeChatToolRunClauses(
    nativeChatToolRunClauses(calls).map(({ category, count }) =>
      words.clause(category, count, live)
    ),
    words
  )
}

function fill(template: string, values: readonly string[]): string {
  return values.reduce(
    (text, value, index) => text.replaceAll(`{{value${index}}}`, value),
    template
  )
}

/** The sentence's words in English. For platforms without i18n (mobile). */
export const NATIVE_CHAT_TOOL_RUN_SENTENCE_ENGLISH: NativeChatToolRunSentenceWords = {
  clause: (category, count, live) => {
    const copy = (
      live ? NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY : NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY
    )[category]
    return count === 1 ? copy.one : fill(copy.many, [String(count)])
  },
  pair: (first, second) => fill(NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.pair, [first, second]),
  list: (leading, last) =>
    fill(NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.list, [
      leading.join(NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.separator),
      last
    ])
}
