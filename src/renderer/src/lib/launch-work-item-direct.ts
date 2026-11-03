import {
  prepareDirectWorkItemSetup,
  type DirectWorkItemLaunchResult
} from './direct-work-item-setup'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  gitLabIssueNumber,
  resolvePrHeadErrorMessage,
  unavailableAgentErrorMessage,
  workspaceActivationErrorMessage
} from '@/lib/launch-work-item-direct-messages'
import type { GitPushTarget } from '../../../shared/worktree/types'
import { buildDirectWorkItemStartupOpts } from '@/lib/launch-work-item-direct-agent'
import {
  getDirectWorkItemIdentity,
  getDirectWorkItemDraftContent,
  getDirectWorkItemWorkspaceNames
} from '@/lib/launch-work-item-direct-draft'
import {
  directWorkItemAgentArgsError,
  resolveDirectPrStartPoint,
  prepareDirectLaunchContext,
  planDirectWorkItemLaunch,
  resolveDirectProspectiveAgent
} from '@/lib/launch-work-item-direct-preflight'
import type { LaunchWorkItemDirectArgs } from '@/lib/launch-work-item-direct-types'
import {
  beginDirectWorkItemStructuredLaunch,
  finishDirectWorkItemPrompt
} from '@/lib/launch-work-item-direct-agent-routing'
import { prepareDirectWorkItemAgentLaunch } from '@/lib/launch-work-item-direct-route-preparation'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'

/** Create/activate a workspace and deliver work-item context to its agent. Setup decisions, unresolved repos or unavailable agents fall back to the modal; paste failures retain the usable workspace and surface a notice. */
export async function launchWorkItemDirect(
  args: LaunchWorkItemDirectArgs
): Promise<DirectWorkItemLaunchResult> {
  const { item, repoId, openModalFallback, baseBranch } = args
  const { telemetrySource, launchSource, agentOverride } = args
  let agentArgs = args.agentArgs
  let creationAccepted = false
  const reportFailure = (message: string): false => {
    toast.error(message)
    args.onFailureNotified?.()
    return false
  }
  try {
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    const store = useAppStore.getState()
    const context = prepareDirectLaunchContext(store, args)
    if (!context) {
      return false
    }
    const { repo } = context
    const promptDelivery = args.promptDelivery ?? 'draft'
    const { itemType, itemNumber } = getDirectWorkItemIdentity(item)
    const finalSetupDecision = await prepareDirectWorkItemSetup(
      repo,
      context.executionHostId,
      args.signal,
      args.onSetupRequired
    )
    if (finalSetupDecision === 'review-request') {
      return false
    }
    if (finalSetupDecision === 'cancelled') {
      return 'cancelled'
    }

    const { workspaceIntentName, workspaceName } = getDirectWorkItemWorkspaceNames(
      item,
      itemType,
      itemNumber
    )
    let resolvedBaseBranch = baseBranch
    let resolvedPushTarget: GitPushTarget | undefined
    let resolvedBranchNameOverride: string | undefined
    let resolvedCompareBaseRef: string | undefined
    if (!resolvedBaseBranch && itemType === 'pr' && itemNumber) {
      try {
        // Direct Use PR bypasses the picker but still needs its resolved head before git worktree add.
        const result = await resolveDirectPrStartPoint(repoId, itemNumber, context.target, item)
        resolvedBaseBranch = result.baseBranch
        resolvedPushTarget = result.pushTarget
        resolvedBranchNameOverride = result.branchNameOverride
        resolvedCompareBaseRef = result.compareBaseRef
      } catch (error) {
        if (args.signal?.aborted) {
          return 'cancelled'
        }
        toast.error(error instanceof Error ? error.message : resolvePrHeadErrorMessage())
        openModalFallback()
        return false
      }
    }

    const projectPreflight = await context.projectContextPromise
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    if (!projectPreflight) {
      toast.error(unavailableAgentErrorMessage())
      return false
    }
    const projectContext = projectPreflight.context
    const { prospectiveAgent, unavailable } = await resolveDirectProspectiveAgent(
      store,
      repo,
      projectContext,
      args
    )
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    if (unavailable) {
      toast.error(unavailableAgentErrorMessage())
      return false
    }
    const requestId = newAgentLaunchRequestId()
    const draftContent = await getDirectWorkItemDraftContent(item, context.repoConnectionId)
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    const preflightPlan = await planDirectWorkItemLaunch({
      requestId,
      prospectiveAgent,
      projectContext,
      repoId,
      repoOwnerHostId: context.executionHostId,
      draftContent,
      promptDelivery,
      resolveSessionOptions: args.resolveSessionOptions,
      sessionOptions: args.sessionOptions,
      launchChoice: args.launchChoice
    })
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    const agentArgsError = directWorkItemAgentArgsError(
      args.agentArgs,
      context.shell,
      Boolean(projectContext && preflightPlan?.route === 'structured-native-chat')
    )
    if (agentArgsError) {
      toast.error(agentArgsError)
      return false
    }

    if (args.signal?.aborted) {
      return 'cancelled'
    }
    creationAccepted = true
    args.onCreateAccepted?.()
    const result = await store.createWorktree(
      repoId,
      workspaceName,
      resolvedBaseBranch,
      finalSetupDecision,
      undefined,
      telemetrySource,
      workspaceIntentName?.displayName ?? item.title,
      itemType === 'issue' && itemNumber ? itemNumber : undefined,
      itemType === 'pr' && itemNumber ? itemNumber : undefined,
      resolvedPushTarget,
      undefined,
      item.linearIdentifier,
      resolvedBranchNameOverride,
      undefined,
      itemType === 'mr' && itemNumber ? itemNumber : undefined,
      gitLabIssueNumber({ ...item, type: itemType, number: itemNumber }),
      undefined,
      undefined,
      undefined,
      item.linearWorkspaceId,
      item.linearOrganizationUrlKey,
      undefined,
      undefined,
      undefined,
      resolvedCompareBaseRef,
      { executionHostId: context.executionHostId }
    )
    const worktreeId = result.worktree.id
    const worktreePath = result.worktree.path

    const launchPreparation = await prepareDirectWorkItemAgentLaunch({
      worktreeId,
      worktreePath,
      repoId,
      agentOverride,
      agentLaunchPreferences: args.agentLaunchPreferences,
      agentArgs: args.agentArgs,
      ...(args.sessionOptions ? { sessionOptions: args.sessionOptions } : {}),
      resolveAgentArgs: args.resolveAgentArgs,
      resolveSessionOptions: args.resolveSessionOptions,
      launchChoice: args.launchChoice,
      sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
      repoConnectionId: context.repoConnectionId,
      repoHost: repo,
      latestStore: useAppStore.getState(),
      draftContent,
      promptDelivery,
      launchPlatform: args.launchPlatform,
      repoLaunchHost: context.repoLaunchHost,
      repoProjectRuntime: context.repoProjectRuntime,
      planLaunch: planAgentSessionLaunch,
      requestId,
      preflightPlan
    })
    if (launchPreparation.unavailable) {
      activateAndRevealWorktree(worktreeId, {
        sidebarRevealBehavior: 'auto',
        setup: result.setup,
        defaultTabs: result.defaultTabs
      })
      return reportFailure(unavailableAgentErrorMessage())
    }
    agentArgs = launchPreparation.agentArgs
    const { effectiveAgent, startupPlan, draftLaunchedNatively, startupPlanFailed, plan } =
      launchPreparation

    const activationHolder: { value: ReturnType<typeof activateAndRevealWorktree> } = {
      value: false
    }
    const revealWorkspace = (): boolean => {
      activationHolder.value = activateAndRevealWorktree(worktreeId, {
        sidebarRevealBehavior: 'auto',
        setup: result.setup,
        defaultTabs: result.defaultTabs,
        ...(launchPreparation.structuredLaunch
          ? { providesInitialSurface: true }
          : buildDirectWorkItemStartupOpts(effectiveAgent, startupPlan, launchSource))
      })
      return activationHolder.value !== false
    }
    const structuredResult = beginDirectWorkItemStructuredLaunch({
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
      // Report a workspace disappearing between create and activation rather than silently drop its draft.
      return reportFailure(workspaceActivationErrorMessage())
    }
    const primaryTabId = structuredResult.completed
      ? structuredResult.primaryTabId
      : activation.primaryTabId

    store.setSidebarOpen(true)

    if (structuredResult.completed) {
      return true
    }

    const completed = finishDirectWorkItemPrompt({
      primaryTabId,
      effectiveAgent,
      promptDelivery,
      draftContent,
      startupPlan,
      draftLaunchedNatively,
      startupPlanFailed
    })
    if (!completed) {
      args.onFailureNotified?.()
    }
    return completed
  } catch (error) {
    if (!creationAccepted && args.signal?.aborted) {
      return 'cancelled'
    }
    return reportFailure(error instanceof Error ? error.message : 'Failed to create workspace.')
  }
}
