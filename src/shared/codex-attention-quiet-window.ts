import { isAskUserQuestionTool } from './agent-question-answered-intent'
import type { AgentStatusState } from './agent-status-types'

/**
 * Why: under Codex "Approve for me" the auto-reviewer resolves the permission pause itself,
 * so every Codex attention signal waits out one quiet window and is dropped if work resumes
 * inside it (#8387/#8519). Shared so the renderer's OS notification and main's fabricated
 * permission BEL cannot drift apart again (#13600).
 */
export const CODEX_ATTENTION_QUIET_MS = 1_500

/** The standalone BEL main fabricates to light up a permission pause. */
export const SYNTHETIC_PERMISSION_BELL = '\x07'

/**
 * Codex-only: no other runtime self-approves its own permission pause, so their permission BEL
 * still rings immediately — matching the renderer's Codex-scoped attention debounce.
 *
 * `request_user_input` also normalizes to `waiting`, but no auto-reviewer ever answers a question
 * put to the user, so it keeps ringing inline rather than paying the quiet window.
 */
export function shouldDeferSyntheticPermissionBell(args: {
  agentType: string | null | undefined
  state: AgentStatusState
  toolName?: string | undefined
}): boolean {
  return (
    args.agentType === 'codex' &&
    (args.state === 'waiting' || args.state === 'blocked') &&
    !isAskUserQuestionTool(args.toolName)
  )
}

/**
 * Terminal-state (non-working) synthetic title frame. The OSC title always lands now so the
 * visible "action required" status is never delayed; only the attention BEL can be held back.
 */
export function buildSyntheticTerminalTitleFrame(args: {
  agentType: string | null | undefined
  state: AgentStatusState
  toolName?: string | undefined
  label: string
}): { frame: string; deferBell: boolean } {
  const needsUserInput = args.state === 'blocked' || args.state === 'waiting'
  const deferBell = shouldDeferSyntheticPermissionBell(args)
  const inlineBell = needsUserInput && !deferBell ? SYNTHETIC_PERMISSION_BELL : ''
  return { frame: `\x1b]0;${args.label}\x07${inlineBell}`, deferBell }
}
