// Claude's compact lifecycle, from Orca's side.
//
// Claude emits PreCompact -> (summarizer SubagentStop) -> SessionStart(source=compact) ->
// PostCompact for a successful /compact, but PreCompact ALONE when the compact aborts
// ("Not enough messages to compact"), and post-compact hooks are only reached on the success
// path. So PreCompact proves nothing and Orca deliberately does not register it: mapping it to
// `working` would strand the pane on every aborted compact, which is the bug this file exists to
// fix (STA-2915/STA-4613).
//
// PostCompact is the only compact event that proves something. `manual` ends at an idle prompt and
// is the pane's missing clearing signal; `auto` fires inside a turn that resumes and emits its own
// Stop, so Orca must not touch the state.

import { agentProviderSessionsEqual } from './agent-session-resume'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentHookSource } from './agent-hook-relay'

export type ClaudeCompactCompletionOwner = {
  source?: AgentHookSource
  connectionId: string | null
  providerSession?: AgentProviderSessionMetadata
  restoredUnconfirmed?: true
  payload: { agentType?: string }
}

export type ClaudeCompactCompletionIncoming = {
  source?: AgentHookSource
  connectionId: string | null
  providerPromptId?: string
  providerSession?: AgentProviderSessionMetadata
}

/** True when a PostCompact may retire the pane's row.
 *
 *  Fails closed on a missing prompt id: the ownership check this replaces required one, and
 *  duplicate suppression has nothing to key on without it. */
export function canAcceptClaudeCompactCompletion(
  previous: ClaudeCompactCompletionOwner | undefined,
  incoming: ClaudeCompactCompletionIncoming
): boolean {
  if (incoming.source !== 'claude' || incoming.providerPromptId === undefined) {
    return false
  }
  // Why: a compact CLEARS a pane, it never creates one. An empty cache means the pane was retired
  // (closed tab, deleted worktree, explicit clear) and a late completion must not resurrect it.
  // The restart case is not this case: hydration restores the stuck row and marks it
  // `restoredUnconfirmed`, so it is handled by the branch below.
  if (previous === undefined) {
    return false
  }
  if (previous.source !== 'claude' || previous.payload.agentType !== 'claude') {
    return false
  }
  if (previous.restoredUnconfirmed) {
    // Why: a hydrated row keeps the PREVIOUS session's connectionId, and rows predating provider
    // session persistence have none at all; neither can contradict the live event, so neither may
    // veto it. Match on provider session only, and only when the row actually carries one.
    return (
      previous.providerSession === undefined ||
      agentProviderSessionsEqual('claude', previous.providerSession, incoming.providerSession)
    )
  }
  return (
    previous.connectionId === incoming.connectionId &&
    agentProviderSessionsEqual('claude', previous.providerSession, incoming.providerSession)
  )
}

/** The compact whose completion a pane has already applied, so relay duplicates cannot keep
 *  refreshing the row. Replaces the suppression the deleted ownership cache provided. */
export function isClaudeCompactCompletionConsumed(
  consumedByPaneKey: Map<string, string>,
  paneKey: string,
  providerPromptId: string | undefined
): boolean {
  return providerPromptId !== undefined && consumedByPaneKey.get(paneKey) === providerPromptId
}

export function markClaudeCompactCompletionConsumed(
  consumedByPaneKey: Map<string, string>,
  paneKey: string,
  providerPromptId: string | undefined
): void {
  if (providerPromptId !== undefined) {
    consumedByPaneKey.set(paneKey, providerPromptId)
  }
}

/** An old relay strips `compactTrigger` from its cached PostCompact before replaying it, so a
 *  replay arrives tagged PostCompact with no manual/auto discriminator. The baseline mapping it was
 *  built with is fixed and known — manual produced `done`, auto produced `working` — so the payload
 *  state stands in for the missing trigger. This substitutes for the trigger only: the caller still
 *  runs the ownership guard above. */
export function resolveLegacyCompactTrigger(
  compactTrigger: 'manual' | 'auto' | undefined,
  payloadState: string
): 'manual' | 'auto' | undefined {
  if (compactTrigger !== undefined) {
    return compactTrigger
  }
  return payloadState === 'done' ? 'manual' : undefined
}
