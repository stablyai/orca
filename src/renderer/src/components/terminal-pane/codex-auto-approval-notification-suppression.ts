import { isAskUserQuestionTool } from '../../../../shared/agent-question-answered-intent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { resolveCodexApprovalReviewer } from '../../../../shared/codex-approval-reviewer'
import {
  isCodexPermissionAttentionState,
  shouldSuppressCodexAutoReviewPermissionAttention
} from '../../../../shared/codex-auto-review-attention'
import { getSyntheticAgentTitleProfile } from '../../../../shared/synthetic-agent-title'
import { resolveTuiAgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import { useAppStore } from '@/store'

type CodexAutoApprovalStatusPayload = AgentCompletionStatusSnapshot &
  Pick<AgentStatusIpcPayload, 'hookEventName' | 'codexApprovalReviewer'>

export type CodexAutoApprovalStatusContext = {
  paneKey: string
  tabId?: string
  terminalHandle?: string
  launchToken?: string
  providerSession?: AgentProviderSessionMetadata
  existingProviderSession?: AgentProviderSessionMetadata
}

function getCodexLaunchConfig(context: CodexAutoApprovalStatusContext) {
  const state = useAppStore.getState()
  if (typeof state.getAgentLaunchConfigForStatusMetadata !== 'function') {
    return undefined
  }
  return state.getAgentLaunchConfigForStatusMetadata({
    paneKey: context.paneKey,
    agentType: 'codex',
    tabId: context.tabId,
    terminalHandle: context.terminalHandle,
    launchToken: context.launchToken,
    providerSession: context.providerSession,
    existingProviderSession:
      context.existingProviderSession ??
      state.agentStatusByPaneKey[context.paneKey]?.providerSession
  })
}

export function shouldSuppressCodexAutoApprovalStatus(
  payload: CodexAutoApprovalStatusPayload,
  context: CodexAutoApprovalStatusContext
): boolean {
  if (payload.agentType !== 'codex' || !isCodexPermissionAttentionState(payload.state)) {
    return false
  }
  // Why: request_user_input waits are real questions the user must answer — yolo auto-approval never resolves them, so they must keep driving status.
  if (isAskUserQuestionTool(payload.toolName)) {
    return false
  }
  const launchConfig = getCodexLaunchConfig(context)
  const reviewer =
    payload.codexApprovalReviewer ?? resolveCodexApprovalReviewer(launchConfig?.agentArgs)
  if (
    shouldSuppressCodexAutoReviewPermissionAttention({
      agentType: payload.agentType,
      state: payload.state,
      hookEventName: payload.hookEventName,
      toolName: payload.toolName,
      reviewer
    })
  ) {
    return true
  }

  if (!launchConfig) {
    return false
  }

  return (
    resolveTuiAgentPermissionMode({
      agent: 'codex',
      agentArgs: launchConfig.agentArgs,
      agentEnv: launchConfig.agentEnv
    }) === 'yolo'
  )
}

export function shouldSuppressCodexAutoApprovalSyntheticTitle(
  title: string,
  context: CodexAutoApprovalStatusContext
): boolean {
  if (title !== getSyntheticAgentTitleProfile('codex')?.permissionLabel) {
    return false
  }

  return shouldSuppressCodexAutoApprovalStatus(
    { state: 'waiting', prompt: '', agentType: 'codex' },
    context
  )
}

export function createCodexAutoApprovalHookCompletionSuppressor(
  paneKey: string,
  getContext?: () => Omit<CodexAutoApprovalStatusContext, 'paneKey'>
): (payload: AgentCompletionStatusSnapshot) => boolean {
  return (payload) =>
    shouldSuppressCodexAutoApprovalStatus(payload, {
      paneKey,
      ...getContext?.()
    })
}
