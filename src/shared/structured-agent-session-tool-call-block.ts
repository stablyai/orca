// The one definition of a structured journal's tool actions: which rows the chat draws as a
// tool call, and the block it draws. The status line reads the same definition, so the sidebar
// names a tool exactly as the chat draws it.

import type {
  AgentJournalDiffItem,
  AgentJournalItemBody,
  AgentJournalToolCallItem
} from './agent-session-journal-types'
import type { NativeChatToolCallBlock } from './native-chat-types'

export type StructuredAgentSessionToolAction = AgentJournalToolCallItem | AgentJournalDiffItem

// Codex rewrites an edit's `apply_patch` call into a diff once its changes exist.
export function isStructuredAgentSessionToolAction(
  body: AgentJournalItemBody | undefined
): body is StructuredAgentSessionToolAction {
  return body?.kind === 'tool-call' || body?.kind === 'diff'
}

/** A diff carries no lifecycle, so it reads as settled; otherwise a finished edit would stay the
 *  running call for the rest of its turn. */
export function isRunningStructuredAgentSessionToolAction(
  action: StructuredAgentSessionToolAction
): boolean {
  return action.kind === 'tool-call' && action.state === 'running'
}

export function structuredAgentSessionToolCallBlock(
  action: StructuredAgentSessionToolAction
): NativeChatToolCallBlock {
  if (action.kind === 'diff') {
    return { type: 'tool-call', name: 'Diff', input: { path: action.path } }
  }
  return {
    type: 'tool-call',
    name: action.name,
    input: action.input,
    state: action.state,
    ...(action.callId !== undefined ? { callId: action.callId } : {}),
    ...(action.mcpIdentity !== undefined ? { mcpIdentity: action.mcpIdentity } : {}),
    ...(action.exitCode !== undefined ? { exitCode: action.exitCode } : {}),
    ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
    ...(action.webSearchResults !== undefined ? { webSearchResults: action.webSearchResults } : {})
  }
}
