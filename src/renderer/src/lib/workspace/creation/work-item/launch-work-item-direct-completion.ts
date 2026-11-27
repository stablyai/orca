import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { workspaceActivationErrorMessage } from './launch-work-item-direct-messages'
import { buildDirectWorkItemStartupOpts } from './launch-work-item-direct-agent'
import type { LaunchWorkItemDirectArgs } from './launch-work-item-direct-types'
import type { DirectWorkItemAgentLaunchPreparation } from './launch-work-item-direct-route-preparation'
import * as routing from './launch-work-item-direct-agent-routing'
import {
  releaseUnclaimedStartupDraft,
  waitForStartupDraftOutcome
} from '../worktree-startup-draft-recovery'

export function completeDirectWorkItemLaunch(input: {
  args: LaunchWorkItemDirectArgs
  result: CreateWorktreeResult
  launchPreparation: DirectWorkItemAgentLaunchPreparation
  launchSource: LaunchWorkItemDirectArgs['launchSource']
  promptDelivery: 'draft' | 'submit-after-ready'
  draftContent: string
  reportFailure: (message: string) => false
  executionHostId: ExecutionHostId
  runtimeOwned: boolean
}): boolean {
  const {
    args,
    result,
    launchPreparation,
    launchSource,
    promptDelivery,
    draftContent,
    reportFailure,
    executionHostId,
    runtimeOwned
  } = input
  const {
    startupDraftReceipt,
    worktree: { id: worktreeId }
  } = result
  const { agentArgs, effectiveAgent, startupPlan, draftLaunchedNatively, startupPlanFailed, plan } =
    launchPreparation
  const gatedDraft =
    result.setup?.waitForAgentStartup === true &&
    startupPlan?.launchConfig.commandProvenance === 'generated' &&
    !launchPreparation.structuredLaunch
      ? startupDraftReceipt
      : undefined
  if (!gatedDraft) {
    releaseUnclaimedStartupDraft(executionHostId, startupDraftReceipt)
  }

  const activationHolder: { value: ReturnType<typeof activateAndRevealWorktree> } = {
    value: false
  }
  const revealWorkspace = (): boolean => {
    activationHolder.value = activateAndRevealWorktree(worktreeId, {
      sidebarRevealBehavior: 'auto',
      ...(gatedDraft
        ? { executionHostId, providesInitialSurface: true, createNewTerminalForStartup: true }
        : {}),
      setup: result.setup,
      defaultTabs: result.defaultTabs,
      ...(launchPreparation.structuredLaunch
        ? { providesInitialSurface: true }
        : buildDirectWorkItemStartupOpts(effectiveAgent, startupPlan, launchSource, {
            ...launchPreparation.freshLaunchInputs,
            prompt: draftContent,
            promptDelivery,
            legacy: () => ({
              startupPlan,
              pasteDraftAfterLaunch: draftLaunchedNatively ? null : draftContent,
              submitPastedPrompt: promptDelivery !== 'draft'
            })
          }))
    })
    return activationHolder.value !== false
  }
  const structuredResult = routing.beginDirectWorkItemStructuredLaunch({
    plan,
    primaryTabId: null,
    beforeOpen: revealWorkspace,
    declinedTerminal: {
      ...(agentArgs !== undefined ? { agentArgs } : {}),
      sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
      ...(args.launchPlatform ? { launchPlatform: args.launchPlatform } : {}),
      ...(launchSource ? { launchSource } : {})
    }
  })
  if (!structuredResult.structuredLaunch) {
    revealWorkspace()
  }
  const activation = activationHolder.value
  if (!activation) {
    releaseUnclaimedStartupDraft(executionHostId, gatedDraft)
    // Report a workspace disappearing between create and activation rather than silently drop its draft.
    return reportFailure(workspaceActivationErrorMessage())
  }
  useAppStore.getState().setSidebarOpen(true)

  if (structuredResult.completed) {
    return true
  }

  if (gatedDraft) {
    void waitForStartupDraftOutcome(executionHostId, gatedDraft).then((outcome) => {
      if (outcome === 'started') {
        routing.finishDirectWorkItemPrompt({
          primaryTabId: activation.primaryTabId,
          effectiveAgent,
          promptDelivery,
          draftContent,
          startupPlan,
          draftLaunchedNatively,
          startupPlanFailed
        })
      }
    })
    return true
  }
  if (runtimeOwned && startupPlan && !startupPlanFailed) {
    // The seeded startup carries the prompt and token until the shared pane delivery owner attaches.
    return (
      routing.directWorkItemStartupAccepted(activation, startupPlan, startupPlanFailed) ||
      reportFailure(workspaceActivationErrorMessage())
    )
  }
  return routing.finishDirectWorkItemPrompt({
    primaryTabId: activation.primaryTabId,
    effectiveAgent,
    promptDelivery,
    draftContent,
    startupPlan,
    draftLaunchedNatively,
    startupPlanFailed,
    onFailureNotified: () => args.onFailureNotified?.()
  })
}
