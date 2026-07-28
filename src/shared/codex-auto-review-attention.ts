import { isAskUserQuestionTool } from './agent-question-answered-intent'
import type { CodexApprovalReviewer } from './codex-approval-reviewer'
import { resolveTuiAgentPermissionMode } from './tui-agent-permissions'

const CODEX_PERMISSION_REQUEST_HOOK = 'PermissionRequest'
const CODEX_PERMISSION_STATES = new Set(['waiting', 'blocked'])

export function isCodexPermissionAttentionState(state: string): boolean {
  return CODEX_PERMISSION_STATES.has(state)
}

export function shouldSuppressCodexAutoReviewPermissionAttention(args: {
  agentType: string | null | undefined
  state: string
  hookEventName: string | undefined
  toolName: string | undefined
  reviewer: CodexApprovalReviewer
}): boolean {
  return (
    args.agentType === 'codex' &&
    isCodexPermissionAttentionState(args.state) &&
    args.hookEventName === CODEX_PERMISSION_REQUEST_HOOK &&
    !isAskUserQuestionTool(args.toolName) &&
    args.reviewer === 'auto_review'
  )
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
  if (
    args.launchConfig &&
    resolveTuiAgentPermissionMode({
      agent: 'codex',
      agentArgs: args.launchConfig.agentArgs,
      agentEnv: args.launchConfig.agentEnv
    }) === 'yolo'
  ) {
    return true
  }
  return shouldSuppressCodexAutoReviewPermissionAttention(args)
}
