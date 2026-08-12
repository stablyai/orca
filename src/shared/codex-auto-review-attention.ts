import { isAskUserQuestionTool } from './agent-question-answered-intent'
import type { CodexApprovalReviewer } from './codex-approval-reviewer'
import { resolveTuiAgentPermissionMode } from './tui-agent-permissions'

const CODEX_PERMISSION_REQUEST_HOOK = 'PermissionRequest'
const CODEX_PERMISSION_STATES = new Set(['waiting', 'blocked'])

export function isCodexPermissionAttentionState(state: string): boolean {
  return CODEX_PERMISSION_STATES.has(state)
}

/**
 * Suppress OS/status attention only when ownership is proven auto-review.
 * Why: fail open for user ownership or unknown reviewer (#13600). Codex waiting
 * without request_user_input is PermissionRequest-shaped, so missing hook names
 * still suppress under proven auto_review; an explicit non-permission hook fails open.
 */
export function shouldSuppressCodexAutoReviewPermissionAttention(args: {
  agentType: string | null | undefined
  state: string
  hookEventName: string | undefined
  toolName: string | undefined
  reviewer: CodexApprovalReviewer
}): boolean {
  if (
    args.agentType !== 'codex' ||
    !isCodexPermissionAttentionState(args.state) ||
    isAskUserQuestionTool(args.toolName) ||
    args.reviewer !== 'auto_review'
  ) {
    return false
  }
  // Why: an explicit non-permission hook must stay visible even under auto_review.
  if (args.hookEventName !== undefined && args.hookEventName !== CODEX_PERMISSION_REQUEST_HOOK) {
    return false
  }
  return true
}

export function shouldSuppressCodexPermissionSyntheticTitle(args: {
  agentType: string | null | undefined
  state: string
  hookEventName: string | undefined
  toolName: string | undefined
  reviewer: CodexApprovalReviewer
  launchConfig:
    | {
        agentArgs?: string | null
        agentEnv?: Record<string, string> | null
      }
    | null
    | undefined
}): boolean {
  if (
    args.agentType !== 'codex' ||
    !isCodexPermissionAttentionState(args.state) ||
    isAskUserQuestionTool(args.toolName)
  ) {
    return false
  }
  // Why: yolo never needs a permission title; keep request_user_input visible above.
  if (
    args.launchConfig &&
    resolveTuiAgentPermissionMode({
      agent: 'codex',
      agentArgs: args.launchConfig.agentArgs,
      agentEnv: args.launchConfig.agentEnv
    }) === 'yolo'
  ) {
    // Why: synthetic titles for yolo only for PermissionRequest when known; unknown hook still yolo-suppresses for parity with status path.
    if (args.hookEventName !== undefined && args.hookEventName !== CODEX_PERMISSION_REQUEST_HOOK) {
      return false
    }
    return true
  }
  return shouldSuppressCodexAutoReviewPermissionAttention(args)
}
