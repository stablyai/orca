import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { planAgentCliArgsSuffix } from '@/lib/tui-agent-startup'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorkspaceIntentName, getWorkspaceSeedName } from '@/lib/new-workspace'
import {
  agentLaunchCommandErrorMessage,
  gitLabIssueNumber,
  resolvePrHeadErrorMessage,
  unavailableAgentErrorMessage,
  workspaceActivationErrorMessage
} from '@/lib/launch-work-item-direct-messages'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { getConnectionId } from '@/lib/connection-context'
import type { GitPushTarget, SetupDecision, TuiAgent } from '../../../shared/types'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import {
  buildDirectWorkItemAgentStartupPlan,
  buildDirectWorkItemStartupOpts,
  markDirectWorkItemAgentTrusted,
  pasteDirectWorkItemDraftWhenAgentReady
} from '@/lib/launch-work-item-direct-agent'
import { getDirectWorkItemDraftContent } from '@/lib/launch-work-item-direct-draft'
import {
  resolveDirectPrStartPoint,
  resolveDirectSetupDecision
} from '@/lib/launch-work-item-direct-preflight'
import type { LaunchWorkItemDirectArgs } from '@/lib/launch-work-item-direct-types'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  ensureWorkItemHostAgents,
  getCreatedWorkItemLaunchPlatform,
  getWorkItemRepoLaunchContext
} from '@/lib/work-item-runtime-host'

/** Creates, activates, and launches an agent for a work item, falling back to the composer when interactive input is required. */
export async function launchWorkItemDirect(args: LaunchWorkItemDirectArgs): Promise<boolean> {
  const { item, repoId, openModalFallback } = args
  const store = useAppStore.getState()
  const repo = findRepoForHost(store.repos, repoId, {
    hostId: args.repoExecutionHostId,
    settings: store.settings
  })
  if (!repo) {
    openModalFallback()
    return false
  }

  const settings = store.settings
  // Why: preflight must match the owner-routed create below, not the focused runtime.
  const repoExecutionHostId = getRepoExecutionHostId(repo)
  const repoOwnerSettings = getSettingsForRepoRuntimeOwner(
    { repos: [repo], settings: store.settings },
    repoId
  )
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
  const repoLaunchContext = getWorkItemRepoLaunchContext(
    store,
    repo,
    repoExecutionHostId,
    args.launchPlatform
  )
  const { runtimeEnvironmentId, projectRuntime: repoProjectRuntime } = repoLaunchContext
  const preflightLaunchPlatform = repoLaunchContext.platform
  const shell = preflightLaunchPlatform === 'win32' ? 'powershell' : 'posix'
  const agentArgsPlan = planAgentCliArgsSuffix(args.agentArgs, shell)
  if (!agentArgsPlan.ok) {
    // Why: direct launches may create a worktree before the agent startup plan
    // is built; reject malformed saved args before touching user workspaces.
    toast.error(agentArgsPlan.error)
    return false
  }
  // Why: overlap cold agent detection with setup resolution and worktree creation.
  const detectedAgentsPromise = args.agentOverride
    ? null
    : ensureWorkItemHostAgents(store, {
        runtimeEnvironmentId,
        connectionId: repoConnectionId,
        localTarget: { repoId }
      })

  const setupResolution = await resolveDirectSetupDecision(
    repoId,
    repo,
    repoOwnerSettings,
    repoExecutionHostId
  )
  if (setupResolution.kind === 'needs-modal') {
    openModalFallback()
    return false
  }

  const trustDecision = await ensureHooksConfirmed(
    useAppStore.getState(),
    repoId,
    'setup',
    repoExecutionHostId
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
  let resolvedBaseBranch = args.baseBranch
  let resolvedPushTarget: GitPushTarget | undefined
  let resolvedBranchNameOverride: string | undefined
  let resolvedCompareBaseRef: string | undefined
  if (!resolvedBaseBranch && itemType === 'pr' && itemNumber) {
    try {
      // Why: direct "Use PR" launches bypass the Start-from picker, so they
      // must still resolve the PR head before `git worktree add`.
      const result = await resolveDirectPrStartPoint(
        repoId,
        itemNumber,
        repoOwnerSettings,
        item,
        repoExecutionHostId
      )
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

  let worktreeId: string
  let primaryTabId: string | null
  let startupPlan = null as ReturnType<typeof buildDirectWorkItemAgentStartupPlan>['startupPlan']
  let effectiveAgent: TuiAgent | null = null
  let draftLaunchedNatively = false
  const draftContent = await getDirectWorkItemDraftContent(item, repoConnectionId)
  let startupPlanFailed = false
  try {
    const result = await store.createWorktree(
      repoId,
      workspaceName,
      resolvedBaseBranch,
      finalSetupDecision,
      undefined,
      args.telemetrySource,
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
      { executionHostId: repoExecutionHostId }
    )
    worktreeId = result.worktree.id
    const worktreePath = result.worktree.path

    const createdConnectionId = getConnectionId(worktreeId)
    // Why: preserve the SSH owner before the new worktree's repo link rehydrates.
    const launchConnectionId = createdConnectionId ?? repoConnectionId
    const latestStore = useAppStore.getState()
    const launchPlatform = getCreatedWorkItemLaunchPlatform(latestStore, {
      executionHostId: repoExecutionHostId,
      connectionId: launchConnectionId,
      worktreeId,
      worktreePath,
      repoProjectRuntime,
      platformOverride: args.launchPlatform
    })
    if (args.agentOverride) {
      const detectedAgents = await ensureWorkItemHostAgents(latestStore, {
        runtimeEnvironmentId,
        connectionId: launchConnectionId,
        localTarget: { worktreeId }
      })
      if (
        !detectedAgents.includes(args.agentOverride) ||
        !isTuiAgentEnabled(args.agentOverride, latestStore.settings?.disabledTuiAgents)
      ) {
        activateAndRevealWorktree(worktreeId, {
          sidebarRevealBehavior: 'auto',
          setup: result.setup
        })
        toast.error(unavailableAgentErrorMessage())
        return false
      }
      effectiveAgent = args.agentOverride
    } else {
      const detectedAgents = runtimeEnvironmentId
        ? await detectedAgentsPromise!
        : launchConnectionId === repoConnectionId
          ? await detectedAgentsPromise!
          : await ensureWorkItemHostAgents(latestStore, {
              connectionId: launchConnectionId,
              localTarget: { worktreeId }
            })
      const detectedIds = new Set(detectedAgents)
      effectiveAgent = pickTuiAgent(
        settings?.defaultTuiAgent,
        detectedIds,
        settings?.disabledTuiAgents
      )
    }
    if (effectiveAgent) {
      // Why: persist late selection for removal safety and ownership; reopen no longer relaunches it.
      void store.updateWorktreeMeta(worktreeId, { createdWithAgent: effectiveAgent }).catch(() => {
        // Non-critical: activation still has the explicit startup below.
      })
    }
    // Why: pre-write trust artifacts so the first prompt is not consumed as menu input.
    await markDirectWorkItemAgentTrusted({
      agent: effectiveAgent,
      workspacePath: worktreePath,
      connectionId: repo.connectionId,
      runtimeEnvironmentId
    })

    ;({ startupPlan, draftLaunchedNatively, startupPlanFailed } =
      buildDirectWorkItemAgentStartupPlan({
        agent: effectiveAgent,
        agentArgs: args.agentArgs,
        draftContent,
        promptDelivery,
        settings,
        launchPlatform,
        // Why: non-local hosts run the plain `orca` shim, so the Linux-only `orca-ide`
        // rename must not be applied for remote launches.
        isRemote: repoExecutionHostId !== LOCAL_EXECUTION_HOST_ID
      }))

    const activation = activateAndRevealWorktree(worktreeId, {
      sidebarRevealBehavior: 'auto',
      setup: result.setup,
      defaultTabs: result.defaultTabs,
      ...buildDirectWorkItemStartupOpts(
        effectiveAgent,
        startupPlan,
        args.launchSource,
        promptDelivery === 'draft' ? draftContent : undefined
      )
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

  if (startupPlanFailed) {
    toast.error(agentLaunchCommandErrorMessage())
    return false
  }

  // Why: draft delivery lands only in the TUI input buffer (argv prefill or
  // startup-owned paste); seed the chat-composer copy so the work-item context
  // isn't invisible in the GUI view.
  if (promptDelivery === 'draft' && primaryTabId && effectiveAgent) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: primaryTabId,
      agent: effectiveAgent,
      text: draftContent
    })
  }

  // Why: at this point the workspace is live and the agent (if any) has
  // been queued on `primaryTabId`. The post-launch paste step below only
  // applies to agents that lacked a native prefill flag; for agents that
  // were launched with the draft already on argv (Claude --prefill today),
  // the context is in the input box already — pasting again would duplicate it.
  if (!primaryTabId || !startupPlan || draftLaunchedNatively) {
    return true
  }
  if (promptDelivery === 'draft' && startupPlan.draftPrompt) {
    // Why: startup-owned draft paste observes the first PTY frames; the older
    // delayed sidecar path can attach too late and miss Codex's ready marker.
    return true
  }

  void pasteDirectWorkItemDraftWhenAgentReady({
    primaryTabId,
    startupPlan,
    content: draftContent,
    submit: promptDelivery === 'submit-after-ready',
    forcePaste: promptDelivery === 'submit-after-ready'
  })
  return true
}
