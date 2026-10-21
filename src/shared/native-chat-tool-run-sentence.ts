// The one line a settled run of tool calls reads as.
//
// A run header names the whole run, so it may only say things true of all of it.
// The previous header said that by printing the calls themselves — a count, then
// a monospace list of tool names and arguments — which reads as a debug dump
// beside the prose it sits under. This says it in words instead, one clause per
// category in the order the run first used them: "Read 7 files, ran 17 commands,
// and searched 4 times".
//
// Built on the category vocabulary that already picks each row's glyph, so the
// sentence and the icon beside it can never claim different things.

import { nativeChatToolCategory, type NativeChatToolCategory } from './native-chat-tool-icon'
import type { NativeChatMcpIdentity } from './native-chat-tool-identity'
import { toolInputCommand } from './native-chat-tool-summary'
import { isToolCallBlock, type NativeChatBlock } from './native-chat-types'

/** Singular/plural per category. Desktop maps these onto `translate`; mobile
 *  formats them directly, so both surfaces read one vocabulary. */
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
  mcpToolCall: { one: 'Used 1 integration', many: 'Used {{value0}} integrations' },
  subAgentActivity: { one: 'Ran 1 agent', many: 'Ran {{value0}} agents' },
  todoList: { one: 'Updated the plan', many: 'Updated the plan {{value0}} times' },
  other: { one: 'Used 1 tool', many: 'Used {{value0}} tools' }
}

/** The present-tense clauses, while the run is still live. Same shape as the
 *  settled ones so the header's text changes in place and nothing else does. */
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
  mcpToolCall: { one: 'Using 1 integration', many: 'Using {{value0}} integrations' },
  subAgentActivity: { one: 'Running 1 agent', many: 'Running {{value0}} agents' },
  todoList: { one: 'Updating the plan', many: 'Updating the plan {{value0}} times' },
  other: { one: 'Using 1 tool', many: 'Using {{value0}} tools' }
}

export const NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS = {
  /** Exactly two clauses. */
  pair: '{{value0}} and {{value1}}',
  /** Three or more: everything but the last, already comma-joined, then the last. */
  list: '{{value0}}, and {{value1}}'
} as const

export type NativeChatToolRunClause = {
  category: NativeChatToolCategory
  count: number
}

/** Each category the run touched, in the order it first used them, with how many
 *  calls it made. First-use order rather than a count ranking: the sentence then
 *  reads in the order the work happened. */
export function nativeChatToolRunClauses(
  calls: readonly { name: string; mcpIdentity?: NativeChatMcpIdentity }[]
): NativeChatToolRunClause[] {
  const counts = new Map<NativeChatToolCategory, number>()
  for (const call of calls) {
    const category = nativeChatToolCategory(call.name, call.mcpIdentity) ?? 'other'
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts].map(([category, count]) => ({ category, count }))
}

/** Join rendered clauses into one sentence. Only the first keeps its capital:
 *  the rest continue the sentence. Lowercasing is locale-aware, and applies to
 *  the clause's first character only, so an acronym inside it survives. */
export function joinNativeChatToolRunClauses(
  clauses: readonly string[],
  format: {
    pair: (first: string, second: string) => string
    list: (leading: string, last: string) => string
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
  return format.list(continued.slice(0, -1).join(', '), continued.at(-1) ?? '')
}

export type NativeChatToolRunSentenceWords = {
  clause: (category: NativeChatToolCategory, count: number, live: boolean) => string
  pair: (first: string, second: string) => string
  list: (leading: string, last: string) => string
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
  // A lone shell call keeps its own command: `git push` identifies the work
  // better than "Ran 1 command" can, and it is the row the reader would open
  // anyway. A call carrying no command has nothing better than its category.
  // Not while live: the command is then the preview beside the sentence, and a
  // header that swapped shape when the second call arrived is the swap this row
  // exists to avoid.
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
  list: (leading, last) => fill(NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.list, [leading, last])
}
