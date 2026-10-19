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

/** `itemId`: the journal row's, the call's id when the provider gave none. A call and its result
 *  are one row, so the result names its call by it; without an id a result pairs with the oldest
 *  unanswered call, which in a run of several rows can be another row's. */
export function structuredAgentSessionToolCallBlock(
  action: StructuredAgentSessionToolAction,
  itemId: string
): NativeChatToolCallBlock {
  if (action.kind === 'diff') {
    return { type: 'tool-call', name: 'Diff', input: { path: action.path }, callId: itemId }
  }
  return {
    type: 'tool-call',
    name: action.name,
    input: action.input,
    state: action.state,
    ...(action.endedAs !== undefined ? { endedAs: action.endedAs } : {}),
    callId: action.callId ?? itemId,
    ...(action.mcpIdentity !== undefined ? { mcpIdentity: action.mcpIdentity } : {}),
    ...(action.exitCode !== undefined ? { exitCode: action.exitCode } : {}),
    ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
    ...(action.webSearchResults !== undefined ? { webSearchResults: action.webSearchResults } : {})
  }
}
