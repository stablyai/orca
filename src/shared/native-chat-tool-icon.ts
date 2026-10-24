import { mcpToolIdentity, type NativeChatMcpIdentity } from './native-chat-tool-identity'
/** Share category glyphs across lifecycle states; change tone/failure marks only, preserving identity.
 * Glyphs are decorative: render the identifying tool word alongside them, never alone. */
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
  /** Outside this vocabulary; distinct from unknown, which specifically means an unclassified shell command. */
  | 'other'

/** Shared lucide ids resolve in lucide-react and lucide-react-native. */
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
  /** Pending-question glyph shares the aligned slot but names no tool category. */
  | 'message-square-more'
  /** The reasoning row's glyph, carried for the same aligned slot; it names no tool category. */
  | 'brain'

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

/** Classify rendered row words, not protocol types; reuse shared edit/command sets.
 * Map avoids truthy inherited object keys such as __proto__. */
const CATEGORY_BY_ROW_WORD = new Map<string, NativeChatToolCategory>([
  // Codex's classified shell rows.
  ['read', 'read'],
  ['search', 'search'],
  ['list', 'listFiles'],
  // Rollout shell names classify glyphs here; the activity set separately controls live-row wording.
  ['exec', 'unknown'],
  ['local_shell', 'unknown'],
  // Codex Diff is a projection, absent from input-carrying edit-tool names.
  ['diff', 'fileChange'],
  // Claude's tool names, which its lane renders verbatim.
  ['grep', 'search'],
  ['glob', 'search'],
  // Claude Task lasts through child execution; Codex spawn_agent returns at launch, so only its roster represents ongoing work.
  ['task', 'subAgentActivity'],
  // Claude's transcript alias of Task.
  ['agent', 'subAgentActivity'],
  ['webfetch', 'webSearch'],
  ['todowrite', 'todoList'],
  ['update_plan', 'todoList'],
  ['web search', 'webSearch'],
  ['websearch', 'webSearch'],
  ['web_search', 'webSearch']
])

/** Use edit-only names: isEditToolName also admits command inputs that quote patches, which remain shell activity. */
const EDIT_ROW_WORDS = new Set([...EDIT_TOOL_NAMES].map((name) => name.toLowerCase()))

/** MCP tools arrive as `mcp__<server>__<tool>` and the row is named after the
 *  tool, so only the prefix identifies one. */
const MCP_TOOL_PREFIX = 'mcp__'

/** The category a row word names, or null when the lane emitted something this
 *  vocabulary doesn't model yet. */
export function nativeChatToolCategory(
  rowWord: string,
  mcpIdentity?: NativeChatMcpIdentity
): NativeChatToolCategory | null {
  const word = rowWord.trim().toLowerCase()
  if (word.startsWith(MCP_TOOL_PREFIX) || mcpToolIdentity(rowWord, mcpIdentity) !== null) {
    return 'mcpToolCall'
  }
  // Commands can carry patches without applying them; command identity takes precedence over edit vocabulary.
  if (isCommandToolName(word)) {
    return 'unknown'
  }
  return CATEGORY_BY_ROW_WORD.get(word) ?? (EDIT_ROW_WORDS.has(word) ? 'fileChange' : null)
}

/** Unknown words retain generic aligned glyphs; reserve terminal claims for calls proven to run commands. */
export function nativeChatToolIconName(
  rowWord: string,
  mcpIdentity?: NativeChatMcpIdentity
): NativeChatToolIconName {
  return NATIVE_CHAT_TOOL_ICON_NAMES[nativeChatToolCategory(rowWord, mcpIdentity) ?? 'other']
}

/** Use a category only when every call shares it; mixed/empty runs return null. */
export function nativeChatToolRunCategory(
  calls: readonly { name: string; mcpIdentity?: NativeChatMcpIdentity }[]
): NativeChatToolCategory | null {
  let shared: NativeChatToolCategory | null = null
  for (const call of calls) {
    const category = nativeChatToolCategory(call.name, call.mcpIdentity) ?? 'other'
    if (shared !== null && shared !== category) {
      return null
    }
    shared = category
  }
  return shared
}

/** Shared-category glyph, generic for mixed runs, or null for empty headers. */
export function nativeChatToolRunIconName(
  calls: readonly { name: string; mcpIdentity?: NativeChatMcpIdentity }[]
): NativeChatToolIconName | null {
  if (calls.length === 0) {
    return null
  }
  return NATIVE_CHAT_TOOL_ICON_NAMES[nativeChatToolRunCategory(calls) ?? 'other']
}

/** Mobile terminal/wrench classification needs input: Codex read/search/list shell rows can share lowercased names with non-shell Claude tools.
 * The retained raw command proves shell execution; Claude Read carries a path only. */
export function isShellActivityToolCall(call: { name: string; input?: unknown }): boolean {
  return isCommandToolName(call.name) || toolInputCommand(call.input) !== null
}
