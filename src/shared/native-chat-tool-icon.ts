/**
 * The category vocabulary for native-chat tool rows, and the one glyph each
 * category keeps. A row is `icon + word + argument`: the icon is decorative and
 * the word carries identity, so a renderer must never draw the glyph alone.
 *
 * The glyph is fixed per category across running/completed/failed — only tone
 * changes, plus a trailing mark on failure. A row that swapped glyphs when it
 * finished would read as changing identity.
 */
import { EDIT_TOOL_NAMES } from './native-chat-diff'
import { isCommandToolName } from './native-chat-tool-activity'
import { toolInputCommand } from './native-chat-tool-summary'

export type NativeChatToolCategory =
  | 'read'
  | 'search'
  | 'listFiles'
  /** A shell command that ran unclassified — Codex's own word for one. */
  | 'unknown'
  | 'fileChange'
  | 'webSearch'
  | 'mcpToolCall'
  | 'subAgentActivity'
  | 'todoList'
  /** A tool this vocabulary doesn't model. Distinct from `unknown`: claiming a
   *  terminal for it would assert a shell ran when nothing says one did. */
  | 'other'

/** lucide glyph ids. Spelled the same by `lucide-react` and `lucide-react-native`,
 *  so desktop and mobile can resolve one name to their own component. */
export type NativeChatToolIconName =
  | 'eye'
  | 'search'
  | 'folder'
  | 'square-terminal'
  | 'pencil'
  | 'globe'
  | 'plug'
  | 'bot'
  | 'list-checks'
  | 'wrench'

/** Category to glyph. */
export const NATIVE_CHAT_TOOL_ICON_NAMES: Record<NativeChatToolCategory, NativeChatToolIconName> = {
  read: 'eye',
  search: 'search',
  listFiles: 'folder',
  unknown: 'square-terminal',
  fileChange: 'pencil',
  webSearch: 'globe',
  mcpToolCall: 'plug',
  subAgentActivity: 'bot',
  todoList: 'list-checks',
  other: 'wrench'
}

/**
 * Row word to category, keyed by the word a lane actually renders rather than by
 * the protocol type, because that word is all a row model carries. The edit
 * family and the command tools come from their own shared sets below, so this
 * table holds only what neither of those already names.
 * A `Map`, not an object: an object index answers `__proto__` with a truthy value.
 */
const CATEGORY_BY_ROW_WORD = new Map<string, NativeChatToolCategory>([
  // Codex's classified shell rows.
  ['read', 'read'],
  ['search', 'search'],
  ['list', 'listFiles'],
  // Codex's rollout-transcript names for a shell call, which the activity set
  // below does not carry: `isCommandToolName` also picks the running row's copy,
  // and this vocabulary only picks a glyph.
  ['exec', 'unknown'],
  ['local_shell', 'unknown'],
  // Every Codex file change projects as a `Diff` call, and the edit set below
  // names the tools that carry the edit in their input, not that projection.
  ['diff', 'fileChange'],
  // Claude's tool names, which its lane renders verbatim.
  ['grep', 'search'],
  ['glob', 'search'],
  ['task', 'subAgentActivity'],
  ['webfetch', 'webSearch'],
  ['todowrite', 'todoList'],
  ['web search', 'webSearch'],
  ['websearch', 'webSearch']
])

/** The edit family, lowercased for row-word matching. Deliberately not
 *  `isEditToolName`: that predicate answers "could this input wrap a patch",
 *  which is true of command tools too, and a shell row is not an edit. */
const EDIT_ROW_WORDS = new Set([...EDIT_TOOL_NAMES].map((name) => name.toLowerCase()))

/** MCP tools arrive as `mcp__<server>__<tool>` and the row is named after the
 *  tool, so only the prefix identifies one. */
const MCP_TOOL_PREFIX = 'mcp__'

/** The category a row word names, or null when the lane emitted something this
 *  vocabulary doesn't model yet. */
export function nativeChatToolCategory(rowWord: string): NativeChatToolCategory | null {
  const word = rowWord.trim().toLowerCase()
  if (word.startsWith(MCP_TOOL_PREFIX)) {
    return 'mcpToolCall'
  }
  // Before the edit family: a command tool runs whatever it is handed, so a
  // patch in its input is not evidence the row is an edit.
  if (isCommandToolName(word)) {
    return 'unknown'
  }
  return CATEGORY_BY_ROW_WORD.get(word) ?? (EDIT_ROW_WORDS.has(word) ? 'fileChange' : null)
}

/** The glyph for a row word. Never empty, so rows stay left-aligned: a word
 *  outside the vocabulary takes the generic tool glyph, and only a row that
 *  really ran a command claims the terminal. */
export function nativeChatToolIconName(rowWord: string): NativeChatToolIconName {
  return NATIVE_CHAT_TOOL_ICON_NAMES[nativeChatToolCategory(rowWord) ?? 'other']
}

/** The one category every call in a run shares, or null when the run spans
 *  categories or holds no calls. A run header names the whole run, not any one
 *  call in it, so it may only claim a category true of all of them. */
export function nativeChatToolRunCategory(
  calls: readonly { name: string }[]
): NativeChatToolCategory | null {
  let shared: NativeChatToolCategory | null = null
  for (const call of calls) {
    const category = nativeChatToolCategory(call.name) ?? 'other'
    if (shared !== null && shared !== category) {
      return null
    }
    shared = category
  }
  return shared
}

/** The glyph for a run header: the shared category's glyph, the generic tool
 *  glyph for a run that spans categories, and null when the run has no tool
 *  call to describe and so heads with no glyph at all. */
export function nativeChatToolRunIconName(
  calls: readonly { name: string }[]
): NativeChatToolIconName | null {
  if (calls.length === 0) {
    return null
  }
  return NATIVE_CHAT_TOOL_ICON_NAMES[nativeChatToolRunCategory(calls) ?? 'other']
}

/** Whether a call reads as terminal activity, for a lane with no per-category
 *  glyph (mobile) that only chooses between a terminal and a generic tool.
 *  The row word cannot decide it alone: Codex names a classified shell row
 *  `read` / `search` / `list`, which lowercase to Claude's own `Read` / `Grep` /
 *  `Glob`, and those ran no command. So the input breaks the tie — Codex keeps
 *  the command it ran, while Claude's `Read` carries only a file path. */
export function isShellActivityToolCall(call: { name: string; input?: unknown }): boolean {
  return isCommandToolName(call.name) || toolInputCommand(call.input) !== null
}
