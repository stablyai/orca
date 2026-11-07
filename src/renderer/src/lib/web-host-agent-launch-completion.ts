import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/hosted-terminals/creation/terminal-create-contracts'
import type { AgentTerminalLaunchCompletion } from './agent-session/launch/structured-agent-session-launch-admission'
import { webTerminalPlacementParentTabId } from '@/runtime/hosted-terminals/placement/web-session-terminal-placement'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { notifyAgentLaunchPromptNotSent } from './agent-launch-prompt-failure-notice'

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
    toast.error(args.failureMessage)
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
