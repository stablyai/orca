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
  resolveDirectSetupDecision
} from '@/lib/launch-work-item-direct-preflight'
import type { LaunchWorkItemDirectArgs } from '@/lib/launch-work-item-direct-types'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { prepareDirectWorkItemAgentLaunch } from '@/lib/launch-work-item-direct-route-preparation'
import { settleDirectWorkItemStructuredLaunch } from '@/lib/launch-work-item-direct-agent-routing'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'

/**
 * "Use" flow: create the workspace, activate it, launch the default agent,
 * and paste the work item context into the agent. Most callers leave it as a draft;
 * fix-check launches can opt into submitting the prompt after the TUI is ready.
 * Falls back to `openModalFallback()` when:
 *   - the repo's `setupRunPolicy` is `'ask'` (the user must pick per-workspace)
 *   - the repo can't be resolved from `repoId`
 *   - no compatible agent is detected on PATH
 *
 * Best-effort: after workspace activation, paste failures only toast a notice — the user still
 * has a usable workspace and can paste the work item context themselves.
 */
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
  const repo = store.repos.find((r) => r.id === repoId)
  if (!repo) {
    openModalFallback()
    return false
  }

  const settings = store.settings
  // Why: preflight (PR base + hooks probe) must run on the repo's owner host so it
  // matches the owner-routed createWorktree below, not the focused runtime.
  const repoOwnerSettings = getSettingsForRepoRuntimeOwner(store, repoId)
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
  const preflightLaunchPlatform =
    args.launchPlatform ??
    resolveSourceControlLaunchPlatform({
      connectionId: repoConnectionId,
      worktreePath: repo.path,
      projectRuntime: repoProjectRuntime
    })
  const shell = preflightLaunchPlatform === 'win32' ? 'powershell' : 'posix'
  const agentArgsPlan = planAgentCliArgsSuffix(agentArgs, shell)
  if (!agentArgsPlan.ok) {
    // Why: direct launches may create a worktree before the agent startup plan
    // is built; reject malformed saved args before touching user workspaces.
    toast.error(agentArgsPlan.error)
    return false
  }
  // Why: agent detection shells out and can be cold/slow. Start it now, but
  // don't let it serialize setup-policy resolution or git worktree creation.
  const detectedAgentsPromise = agentOverride
    ? null
    : repoConnectionId
      ? store.ensureRemoteDetectedAgents(repoConnectionId)
      : store.ensureDetectedAgents()

  const setupResolution = await resolveDirectSetupDecision(repoId, repo, repoOwnerSettings)
  if (setupResolution.kind === 'needs-modal') {
    openModalFallback()
    return false
  }

  const trustDecision = await ensureHooksConfirmed(useAppStore.getState(), repoId, 'setup')
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
      // Why: direct "Use PR" launches bypass the Start-from picker, so they
      // must still resolve the PR head before `git worktree add`.
      const result = await resolveDirectPrStartPoint(repoId, itemNumber, repoOwnerSettings, item)
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
  const draftContent = await getDirectWorkItemDraftContent(item, repoConnectionId)
  let startupPlanFailed = false
  let launchPlan: AgentSessionLaunchPlan | null = null
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
      resolvedCompareBaseRef
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
      detectedAgentsPromise,
      latestStore,
      settings,
      draftContent,
      promptDelivery,
      launchPlatform: args.launchPlatform,
      repoProjectRuntime,
      planLaunch: planAgentSessionLaunch
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
    launchPlan = launchPreparation.plan

    const activation = activateAndRevealWorktree(worktreeId, {
      sidebarRevealBehavior: 'auto',
      setup: result.setup,
      defaultTabs: result.defaultTabs,
      ...(!launchPreparation.structuredLaunch
        ? buildDirectWorkItemStartupOpts(
            effectiveAgent,
            startupPlan,
            launchSource,
            promptDelivery === 'draft' ? draftContent : undefined
          )
        : {})
    })
    if (!activation) {
      // Worktree vanished between create and activate — extremely unlikely but
      // worth handling explicitly rather than silently dropping the draft.
      toast.error(workspaceActivationErrorMessage())
      return false
    }
    primaryTabId = activation.primaryTabId
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace.'
    toast.error(message)
    return false
  }

  store.setSidebarOpen(true)

  const structuredResult = await settleDirectWorkItemStructuredLaunch({
    plan: launchPlan,
    worktreeId,
    workspacePath: worktreePath,
    connectionId: repoConnectionId,
    primaryTabId,
    startupPlan,
    launchSource,
    agentArgs,
    launchPlatform: args.launchPlatform
  })
  // A structured refusal's terminal fallback already prepared, spawned, and delivered the prompt
  // through launchAgentSession; do not seed or paste it again in the legacy tail below.
  const promptHandledByStructuredLauncher =
    launchPlan?.route === 'structured-native-chat' && !structuredResult.structuredLaunch
  if (structuredResult.structuredLaunch) {
    if (structuredResult.completed) {
      return true
    }
    if (structuredResult.visibilityUnknown || structuredResult.failed) {
      return false
    }
    primaryTabId = structuredResult.primaryTabId
  }

  if (startupPlanFailed) {
    toast.error(agentLaunchCommandErrorMessage())
    return false
  }

  if (
    !promptHandledByStructuredLauncher &&
    primaryTabId &&
    effectiveAgent &&
    promptDelivery === 'draft'
  ) {
    // Why: the draft rides in on argv or the startup payload, so no paste runs
    // below; mirror it into chat the way the new-tab launcher does.
    seedNativeChatLaunchDraftForAgentTab({
      tabId: primaryTabId,
      agent: effectiveAgent,
      text: draftContent
    })
  }
  if (
    !promptHandledByStructuredLauncher &&
    primaryTabId &&
    startupPlan &&
    !draftLaunchedNatively &&
    !(promptDelivery === 'draft' && startupPlan.draftPrompt)
  ) {
    const submit = promptDelivery === 'submit-after-ready'
    const delivery = deliverLaunchPromptToAgentTab({
      tabId: primaryTabId,
      agent: startupPlan.agent,
      content: draftContent,
      submit,
      forcePaste: submit,
      onTimeout: () => notifyDirectWorkItemAgentStartTimeout(startupPlan.agent, submit)
    })
    void delivery.catch((error) =>
      console.error('Prompt delivery failed after direct launch', error)
    )
  }
  return true
}
