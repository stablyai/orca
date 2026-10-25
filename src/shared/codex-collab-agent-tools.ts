// The tool rows a Codex `collabAgentToolCall` item becomes: the calls an agent makes to spawn,
// message, wait on and close its helpers. The host names each row; readers recognise it here.

/** The name the model called the tool by, which is what its row shows. The wire item spells the
 *  tool in camelCase; the model-facing name is snake_case, so this map is not a spelling fix. */
const CODEX_COLLAB_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ['spawnAgent', 'spawn_agent'],
  ['sendInput', 'send_input'],
  ['resumeAgent', 'resume_agent'],
  ['wait', 'wait_agent'],
  ['closeAgent', 'close_agent'],
  ['sendMessage', 'send_message'],
  ['followupTask', 'followup_task'],
  ['interruptAgent', 'interrupt_agent'],
  ['listAgents', 'list_agents']
])

const CODEX_COLLAB_ROW_NAMES: ReadonlySet<string> = new Set(CODEX_COLLAB_TOOL_NAMES.values())

/** A tool Codex adds later keeps its wire spelling. */
export function codexCollabToolRowName(wireTool: string): string {
  return CODEX_COLLAB_TOOL_NAMES.get(wireTool) ?? wireTool
}

export function isCodexCollabToolRowName(name: string): boolean {
  return CODEX_COLLAB_ROW_NAMES.has(name)
}

/** The row input's key for the helper thread ids a call acts on, in the order the call names them. */
export const CODEX_COLLAB_ROW_AGENTS_KEY = 'agents'

/** The helper thread ids a collab call row names; none when its input was clipped. */
export function codexCollabRowAgentIds(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || !(CODEX_COLLAB_ROW_AGENTS_KEY in input)) {
    return []
  }
  const ids = input[CODEX_COLLAB_ROW_AGENTS_KEY]
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
}
