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

/** The sentence in English. For platforms without i18n (mobile). */
export function formatNativeChatToolRunSentence(
  calls: readonly { name: string; mcpIdentity?: NativeChatMcpIdentity }[]
): string {
  const rendered = nativeChatToolRunClauses(calls).map(({ category, count }) => {
    const copy = NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY[category]
    return count === 1 ? copy.one : copy.many.replaceAll('{{value0}}', String(count))
  })
  return joinNativeChatToolRunClauses(rendered, {
    pair: (first, second) =>
      NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.pair
        .replaceAll('{{value0}}', first)
        .replaceAll('{{value1}}', second),
    list: (leading, last) =>
      NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.list
        .replaceAll('{{value0}}', leading)
        .replaceAll('{{value1}}', last)
  })
}
