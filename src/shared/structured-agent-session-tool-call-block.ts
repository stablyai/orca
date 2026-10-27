// Share tool-action projection between chat and sidebar so status names exactly the tool block the transcript draws.

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

/** Diffs have no lifecycle and are settled, or completed edits would remain running all turn. */
export function isRunningStructuredAgentSessionToolAction(
  action: StructuredAgentSessionToolAction
): boolean {
  return action.kind === 'tool-call' && action.state === 'running'
}

/** Use row itemId when provider call ID is absent so the result cannot pair with another row’s oldest unanswered call. */
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
