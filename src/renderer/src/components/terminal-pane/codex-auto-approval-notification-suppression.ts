import { isAskUserQuestionTool } from '../../../../shared/agent-question-answered-intent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { getSyntheticAgentTitleProfile } from '../../../../shared/synthetic-agent-title'
import { resolveTuiAgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import { useAppStore } from '@/store'

const CODEX_AUTO_APPROVED_PERMISSION_STATES = ['waiting', 'blocked'] as const

export type CodexAutoApprovalStatusContext = {
  paneKey: string
  tabId?: string
  terminalHandle?: string
  launchToken?: string
  providerSession?: AgentProviderSessionMetadata
  existingProviderSession?: AgentProviderSessionMetadata
}

function isCodexAutoApprovedPermissionState(
  state: AgentCompletionStatusSnapshot['state']
): state is (typeof CODEX_AUTO_APPROVED_PERMISSION_STATES)[number] {
  return CODEX_AUTO_APPROVED_PERMISSION_STATES.some((permissionState) => permissionState === state)
}

export function shouldSuppressCodexAutoApprovalStatus(
  payload: AgentCompletionStatusSnapshot,
  context: CodexAutoApprovalStatusContext
): boolean {
  if (payload.agentType !== 'codex' || !isCodexAutoApprovedPermissionState(payload.state)) {
    return false
  }
  // Why: request_user_input waits are real questions the user must answer — yolo auto-approval never resolves them, so they must keep driving status.
  if (isAskUserQuestionTool(payload.toolName)) {
    return false
  }

  const state = useAppStore.getState()
  if (typeof state.getAgentLaunchConfigForStatusMetadata !== 'function') {
    return false
  }

  const launchConfig = state.getAgentLaunchConfigForStatusMetadata({
    paneKey: context.paneKey,
    agentType: 'codex',
    tabId: context.tabId,
    terminalHandle: context.terminalHandle,
    launchToken: context.launchToken,
    providerSession: context.providerSession,
    existingProviderSession: context.existingProviderSession
  })
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
