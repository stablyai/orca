import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/hosted-terminals/creation/terminal-create-contracts'
import { structuredAgentLabel } from '../structured-agent-session-launch-label'
import { translate } from '@/i18n/i18n'
import type { AgentTerminalLaunchCompletion } from '../structured-agent-session-launch-admission'
import { webTerminalPlacementParentTabId } from '@/runtime/hosted-terminals/placement/web-session-terminal-placement'
import { toWebTerminalSurfaceTabId } from '../../../../../../shared/workspace-layout/terminal-surface-id'
import { notifyAgentLaunchPromptNotSent } from '../prompt/agent-launch-prompt-failure-notice'

/** An id this client just minted can only be refused as future-dated when the host clock trails it past the skew allowance; the bare message covers hosts that predate refusal details. */
function isHostClockBehindCreateFailure(outcome: WebRuntimeTerminalCreateOutcome): boolean {
  return (
    outcome.status === 'failed' &&
    ((outcome.refusal?.code === 'agent_session_operation_invalid' &&
      outcome.refusal?.details?.reason === 'operationIdInvalid') ||
      outcome.message === 'agent_session_operation_invalid')
  )
}

export function completeWebHostAgentLaunch(args: {
  agent: TuiAgent
  worktreeId: string
  activate?: boolean
  prompt: string
  onPromptDelivered?: () => void
  legacyPreparationCancelled: boolean
  failureMessage: string
  outcome: WebRuntimeTerminalCreateOutcome
  promptDelivered: boolean
  submitFollowup?: boolean
  hostTabId?: string
}): { delivered: boolean; failureNotified: boolean } & AgentTerminalLaunchCompletion {
  const { outcome, promptDelivered, hostTabId } = args
  if (outcome.status === 'failed') {
    if (args.legacyPreparationCancelled) {
      return { delivered: false, failureNotified: true, outcome: { status: 'failed', message: '' } }
    }
    toast.error(
      isHostClockBehindCreateFailure(outcome)
        ? translate(
            'agentLaunch.terminalClockSkew',
            "Couldn't open a terminal for {{value0}} because this computer's clock is ahead of the Orca server. Turn on automatic time, then try again.",
            { value0: structuredAgentLabel(args.agent) }
          )
        : args.failureMessage
    )
    return { delivered: false, failureNotified: true, outcome }
  }
  if (args.activate !== false) {
    useAppStore.getState().setActiveTabType('terminal', args.worktreeId)
  }
  const hasPrompt = args.prompt.length > 0
  if (hasPrompt && promptDelivered) {
    args.onPromptDelivered?.()
  }
  const failureNotified = hasPrompt && !promptDelivered
  if (failureNotified) {
    notifyAgentLaunchPromptNotSent(args.agent, args.submitFollowup ? args.prompt : undefined)
  }
  return {
    delivered: promptDelivered,
    failureNotified,
    outcome,
    ...(hostTabId
      ? { tabId: toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(hostTabId)) }
      : {})
  }
}
