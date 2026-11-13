import { pickApprovedSetupHashes } from '../../../../../../shared/worktree/approved-setup-hashes'
import { agentLaunchRecoveryMessage } from '@/lib/agent-session/launch/failure/agent-launch-failure'
import { confirmDirectWorkItemSetup, prepareDirectWorkItemSetup } from './direct-work-item-setup'
import type { DirectWorkItemLaunchResult } from './direct-work-item-setup'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  directWorkItemFailureReporter,
  gitLabIssueNumber,
  resolvePrHeadErrorMessage,
  unavailableAgentErrorMessage,
  workspaceActivationErrorMessage
} from '@/lib/workspace/creation/work-item/launch-work-item-direct-messages'
import type { GitHubPrStartPoint } from '../../../../../../shared/worktree/types'
import { buildDirectWorkItemStartupOpts } from '@/lib/workspace/creation/work-item/launch-work-item-direct-agent'
import {
  getDirectWorkItemIdentity,
  getDirectWorkItemWorkspaceNames
} from '@/lib/workspace/creation/work-item/launch-work-item-direct-draft'
import { getLaunchableWorkItemDraftContent } from '@/lib/work-items/linked-work-item-context'
import {
  directWorkItemAgentArgsError,
  resolveDirectPrStartPoint,
  prepareDirectLaunchContext,
  planDirectWorkItemLaunch,
  resolveDirectProspectiveAgent,
  captureDirectWorkItemLaunchArgs
} from '@/lib/workspace/creation/work-item/launch-work-item-direct-preflight'
import type { LaunchWorkItemDirectArgs } from '@/lib/workspace/creation/work-item/launch-work-item-direct-types'
import * as routing from './launch-work-item-direct-agent-routing'
import { prepareDirectWorkItemAgentLaunch } from '@/lib/workspace/creation/work-item/launch-work-item-direct-route-preparation'
import { planAgentSessionLaunch } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'

import { createNonSecureContextUuid } from '../../../../../../shared/non-secure-context-uuid'
/** Create/activate a workspace and deliver work-item context to its agent. Setup decisions, unresolved repos or unavailable agents fall back to the modal; paste failures retain the usable workspace and surface a notice. */
export async function launchWorkItemDirect(
  args: LaunchWorkItemDirectArgs
): Promise<DirectWorkItemLaunchResult> {
  const { item, repoId, openModalFallback, baseBranch } = args
  const { telemetrySource, launchSource, agentOverride } = args
  args = captureDirectWorkItemLaunchArgs(args)
  let agentArgs = args.agentArgs
  let creationAccepted = false
  let failureAgent = agentOverride
  const reportFailure = directWorkItemFailureReporter(args.onFailureNotified, () => failureAgent)
  try {
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    const store = useAppStore.getState()
    const context = prepareDirectLaunchContext(store, args)
    if (!context) {
      return false
    }
    if (context.unavailable) {
      return context.unavailable.pending
        ? 'cancelled'
        : reportFailure(agentLaunchRecoveryMessage(context.unavailable.recovery))
    }
    const { repo } = context
    const promptDelivery = args.promptDelivery ?? 'draft'
    const { itemType, itemNumber } = getDirectWorkItemIdentity(item)
    const setupDecision = await prepareDirectWorkItemSetup(
      repo,
      context.executionHostId,
      args.signal,
      args.onSetupRequired
    )
    if (setupDecision === 'review-request' || setupDecision === 'cancelled') {
      return setupDecision === 'cancelled' ? 'cancelled' : false
    }
    const { workspaceIntentName, workspaceName } = getDirectWorkItemWorkspaceNames(
      item,
      itemType,
      itemNumber
    )
    let prStart: GitHubPrStartPoint | undefined
    if (!baseBranch && itemType === 'pr' && itemNumber) {
      try {
        // Direct Use PR bypasses the picker but still needs its resolved head before git worktree add.
        prStart = await resolveDirectPrStartPoint(repoId, itemNumber, context.target, item)
      } catch {
        if (args.signal?.aborted) {
          return 'cancelled'
        }
        reportFailure(resolvePrHeadErrorMessage())
        openModalFallback()
        return false
      }
    }
    const resolvedBaseBranch = prStart?.baseBranch ?? baseBranch
    // Approve the orca.yaml at the start point the create checks out, so a PR's own setup is what's reviewed.
    const confirmedSetup = await confirmDirectWorkItemSetup(
      repo,
      context.executionHostId,
      setupDecision,
      { kind: 'base', baseBranch: resolvedBaseBranch },
      args.signal
    )
    if (confirmedSetup === 'cancelled') {
      return 'cancelled'
    }

    const projectPreflight = await context.projectContextPromise
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    if (!projectPreflight) {
      return reportFailure(unavailableAgentErrorMessage())
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
    failureAgent = prospectiveAgent ?? undefined
    if (unavailable) {
      return reportFailure(unavailableAgentErrorMessage())
    }
    const requestId = createNonSecureContextUuid()
    const draftContent = await Promise.resolve(getLaunchableWorkItemDraftContent(item))
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    const preflightInputs =
      prospectiveAgent && args.resolveLaunchInputs
        ? structuredClone(args.resolveLaunchInputs(prospectiveAgent))
        : undefined
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
      chatSessionOptions: args.chatSessionOptions,
      ...(preflightInputs ? { launchInputs: preflightInputs } : {}),
      launchChoice: args.launchChoice
    })
    if (args.signal?.aborted) {
      return 'cancelled'
    }
    const agentArgsError = directWorkItemAgentArgsError(
      preflightInputs ? preflightInputs.agentArgs : args.agentArgs,
      context.shell,
      Boolean(projectContext && preflightPlan?.route === 'structured-native-chat'),
      failureAgent
    )
    if (agentArgsError) {
      return reportFailure(agentArgsError)
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
      confirmedSetup.setupDecision,
      undefined,
      telemetrySource,
      workspaceIntentName?.displayName ?? item.title,
      itemType === 'issue' && itemNumber ? itemNumber : undefined,
      itemType === 'pr' && itemNumber ? itemNumber : undefined,
      prStart?.pushTarget,
      undefined,
      item.linearIdentifier,
      prStart?.branchNameOverride,
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
      prStart?.compareBaseRef,
      {
        executionHostId: context.executionHostId,
        ...pickApprovedSetupHashes(confirmedSetup)
      }
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
      actionAgentArgs: args.actionAgentArgs,
      ...(args.sessionOptions ? { sessionOptions: args.sessionOptions } : {}),
      resolveLaunchInputs: args.resolveLaunchInputs,
      ...(preflightInputs ? { preflightInputs } : {}),
      chatSessionOptions: args.chatSessionOptions,
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
      // Report a workspace disappearing between create and activation rather than silently drop its draft.
      return reportFailure(workspaceActivationErrorMessage())
    }
    store.setSidebarOpen(true)

    if (structuredResult.completed) {
      return true
    }

    if (context.target.kind === 'environment' && startupPlan && !startupPlanFailed) {
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
  } catch (error) {
    if (!creationAccepted && args.signal?.aborted) {
      return 'cancelled'
    }
    return reportFailure(error instanceof Error ? error.message : 'Failed to create workspace.')
  }
}
