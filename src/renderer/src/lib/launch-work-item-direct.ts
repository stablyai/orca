import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '@/lib/agent-launch-prompt-delivery'
import { planAgentCliArgsSuffix } from '@/lib/tui-agent-startup'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { CLIENT_PLATFORM, getWorkspaceIntentName, getWorkspaceSeedName } from '@/lib/new-workspace'
import {
  agentLaunchCommandErrorMessage,
  gitLabIssueNumber,
  resolvePrHeadErrorMessage,
  unavailableAgentErrorMessage,
  workspaceActivationErrorMessage
} from '@/lib/launch-work-item-direct-messages'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import type { GitPushTarget } from '../../../shared/worktree/types'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import type { buildDirectWorkItemAgentStartupPlan } from '@/lib/launch-work-item-direct-agent'
import {
  buildDirectWorkItemStartupOpts,
  notifyDirectWorkItemAgentStartTimeout
} from '@/lib/launch-work-item-direct-agent'
import { getDirectWorkItemDraftContent } from '@/lib/launch-work-item-direct-draft'
import {
  resolveDirectPrStartPoint,
  resolveDirectLaunchOwnerRow,
  resolveDirectSetupDecision
} from '@/lib/launch-work-item-direct-preflight'
import type { LaunchWorkItemDirectArgs } from '@/lib/launch-work-item-direct-types'
import {
  refineLocalLaunchPlatform,
  resolveRepoExecutionHostPlatform
} from '@/lib/execution-host-facts'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { beginDirectWorkItemStructuredLaunch } from '@/lib/launch-work-item-direct-agent-routing'
import { prepareDirectWorkItemAgentLaunch } from '@/lib/launch-work-item-direct-route-preparation'
import {
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { ensureDetectedAgentsForRepo } from '@/lib/agent-detection-target-inventory'

/** Create/activate a workspace and deliver work-item context to its agent. Setup decisions, unresolved repos or unavailable agents fall back to the modal; paste failures retain the usable workspace and surface a notice. */
export async function launchWorkItemDirect(args: LaunchWorkItemDirectArgs): Promise<boolean> {
  const {
    item,
    repoId,
    openModalFallback,
    baseBranch,
    telemetrySource,
    launchSource,
    agentOverride,
    agentArgs
  } = args
  const store = useAppStore.getState()
  const owner = resolveDirectLaunchOwnerRow(store.repos, repoId)
  if (!owner) {
    openModalFallback()
    return false
  }
  const { repo, executionHostId: repoOwnerHostId, target: repoOwnerTarget } = owner

  const settings = store.settings
  const promptDelivery = args.promptDelivery ?? 'draft'
  const repoConnectionId = repo.connectionId?.trim() || null
  const githubIdentity =
    item.number !== null && (item.type === 'issue' || item.type === 'pr')
      ? resolveGitHubWorkItemIdentity({
          type: item.type,
          number: item.number,
          url: item.url
        })
      : null
  const itemType = githubIdentity?.type ?? item.type
  const itemNumber = githubIdentity?.number ?? item.number
  const repoProjectRuntime = repoConnectionId
    ? undefined
    : getLocalRepoProjectExecutionRuntimeContext(store, repoId, CLIENT_PLATFORM)
  // Why: the agent runs on the repo's execution host, so its OS decides quoting, not this client's (#27971).
  const repoLaunchFact = resolveRepoExecutionHostPlatform(store, repo, () => repoProjectRuntime)
  if (repoLaunchFact.kind === 'withheld') {
    toast.error(repoLaunchFact.reason)
    return false
  }
  const repoLaunchHost = refineLocalLaunchPlatform(repoLaunchFact, args.launchPlatform)
  const shell = repoLaunchHost.platform === 'win32' ? 'powershell' : 'posix'
  const agentArgsPlan = planAgentCliArgsSuffix(agentArgs, shell)
  if (!agentArgsPlan.ok) {
    // Validate saved arguments before creation; planning after create would otherwise leave an invalid launch’s workspace behind.
    toast.error(agentArgsPlan.error)
    return false
  }
  // Start cold agent detection concurrently without delaying setup policy or workspace creation.
  const detectedAgentsPromise = agentOverride ? null : ensureDetectedAgentsForRepo(store, repo)

  const setupResolution = await resolveDirectSetupDecision(repoId, repo, repoOwnerHostId)
  if (setupResolution.kind === 'needs-modal') {
    openModalFallback()
    return false
  }

  const trustDecision = await ensureHooksConfirmed(
    useAppStore.getState(),
    repoId,
    'setup',
    repoOwnerHostId
  )
  const finalSetupDecision: SetupDecision =
    trustDecision === 'skip' ? 'skip' : setupResolution.decision

  const workspaceIntentName =
    itemNumber !== null
      ? getWorkspaceIntentName({
          sourceText: item.pasteContent,
          workItem: { ...item, type: itemType, number: itemNumber }
        })
      : null
  const workspaceName = getWorkspaceSeedName({
    explicitName: item.linearIdentifier
      ? getLinearIssueWorkspaceName({ identifier: item.linearIdentifier, title: item.title })
      : (workspaceIntentName?.seedName ?? ''),
    prompt: '',
    linkedIssueNumber: itemType === 'issue' ? (itemNumber ?? null) : null,
    linkedPR: itemType === 'pr' ? (itemNumber ?? null) : null
  })
  let resolvedBaseBranch = baseBranch
  let resolvedPushTarget: GitPushTarget | undefined
  let resolvedBranchNameOverride: string | undefined
  let resolvedCompareBaseRef: string | undefined
  if (!resolvedBaseBranch && itemType === 'pr' && itemNumber) {
    try {
      // Direct Use PR bypasses the picker but still needs its resolved head before git worktree add.
      const result = await resolveDirectPrStartPoint(repoId, itemNumber, repoOwnerTarget, item)
      resolvedBaseBranch = result.baseBranch
      resolvedPushTarget = result.pushTarget
      resolvedBranchNameOverride = result.branchNameOverride
      resolvedCompareBaseRef = result.compareBaseRef
    } catch (error) {
      toast.error(error instanceof Error ? error.message : resolvePrHeadErrorMessage())
      openModalFallback()
      return false
    }
  }

  let worktreeId: string,
    worktreePath = ''
  let primaryTabId: string | null
  let startupPlan = null as ReturnType<typeof buildDirectWorkItemAgentStartupPlan>['startupPlan']
  let effectiveAgent: TuiAgent | null = null
  let draftLaunchedNatively = false
  let plan: AgentSessionLaunchPlan | null = null
  let structuredLaunchCompleted = false
  const draftContent = await getDirectWorkItemDraftContent(item, repoConnectionId)
  let startupPlanFailed = false
  try {
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
      { executionHostId: repoOwnerHostId }
    )
    worktreeId = result.worktree.id
    worktreePath = result.worktree.path

    const latestStore = useAppStore.getState()
    const launchPreparation = await prepareDirectWorkItemAgentLaunch({
      worktreeId,
      worktreePath,
      repoId,
      agentOverride,
      agentArgs,
      repoConnectionId,
      repoHost: repo,
      detectedAgentsPromise,
      latestStore,
      settings,
      draftContent,
      promptDelivery,
      launchPlatform: args.launchPlatform,
      repoLaunchHost,
      repoProjectRuntime,
      planLaunch: planAgentSessionLaunch,
      requestId: newAgentLaunchRequestId()
    })
    if (launchPreparation.unavailable) {
      activateAndRevealWorktree(worktreeId, {
        sidebarRevealBehavior: 'auto',
        setup: result.setup
      })
      toast.error(unavailableAgentErrorMessage())
      return false
    }
    effectiveAgent = launchPreparation.effectiveAgent
    startupPlan = launchPreparation.startupPlan
    draftLaunchedNatively = launchPreparation.draftLaunchedNatively
    startupPlanFailed = launchPreparation.startupPlanFailed
    plan = launchPreparation.plan

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
      toast.error(workspaceActivationErrorMessage())
      return false
    }
    structuredLaunchCompleted = structuredResult.completed
    primaryTabId = structuredResult.completed
      ? structuredResult.primaryTabId
      : activation.primaryTabId
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace.'
    toast.error(message)
    return false
  }

  store.setSidebarOpen(true)

  if (structuredLaunchCompleted) {
    return true
  }

  if (startupPlanFailed) {
    toast.error(agentLaunchCommandErrorMessage())
    return false
  }

  if (primaryTabId && effectiveAgent && promptDelivery === 'draft') {
    // Mirror argv/startup-payload drafts into chat because the paste path below will not seed them.
    seedNativeChatLaunchDraftForAgentTab({
      tabId: primaryTabId,
      agent: effectiveAgent,
      text: draftContent
    })
  }
  if (
    primaryTabId &&
    startupPlan &&
    !draftLaunchedNatively &&
    !(promptDelivery === 'draft' && startupPlan.draftPrompt)
  ) {
    const submit = promptDelivery === 'submit-after-ready'
    const agent = startupPlan.agent
    void deliverLaunchPromptToAgentTab({
      tabId: primaryTabId,
      agent,
      content: draftContent,
      submit,
      forcePaste: submit,
      onTimeout: () => notifyDirectWorkItemAgentStartTimeout(agent, submit)
    })
  }
  return true
}
