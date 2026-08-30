import type { AgentType } from './agent-status-types'
import { isAskUserQuestionTool } from './agent-question-answered-intent'

/** Baseline snapshot captured when the transcript watch observed the deny.
 *  The hook server re-validates every field against its own cached status so
 *  a racing real hook always wins over the inference. */
export type ClaudePermissionDenyInferenceRequest = {
  paneKey: string
  baselineUpdatedAt: number
  baselineStateStartedAt: number
  baselinePrompt: string
  baselineAgentType: AgentType | undefined
}

/** A real tool-permission wait — the sticky kind no hook clears on deny.
 *  AskUserQuestion also arrives as PermissionRequest on newer Claude, so tool
 *  name (not hook event) discriminates; questions clear via their own inference. */
export function isClaudeToolPermissionWait(entry: {
  state: string
  agentType?: string
  toolName?: string
}): boolean {
  return (
    entry.state === 'waiting' &&
    entry.agentType === 'claude' &&
    !isAskUserQuestionTool(entry.toolName)
  )
}
