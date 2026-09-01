import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  loadDirectLaunchAgentCatalog,
  resolveDirectLaunchAgent
} from '@/lib/launch-work-item-direct-agent-selection'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorkspaceIntentName, getWorkspaceSeedName } from '@/lib/new-workspace'
import {
  gitLabIssueNumber,
  resolvePrHeadErrorMessage,
  unavailableAgentErrorMessage,
  workspaceActivationErrorMessage
} from '@/lib/launch-work-item-direct-messages'
import {
  agentLaunchFailureMessage,
  agentLaunchRequestErrorMessage
} from '@/lib/agent-launch-failure-copy'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'
import type { GitPushTarget, SetupDecision } from '../../../shared/types'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import { getDirectWorkItemDraftContent } from '@/lib/launch-work-item-direct-draft'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import {
  resolveDirectPrStartPoint,
  resolveDirectSetupDecision
} from '@/lib/launch-work-item-direct-preflight'
import type { LaunchWorkItemDirectArgs } from '@/lib/launch-work-item-direct-types'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'

/**
 * "Use" flow: create the workspace, activate it, and launch the default agent
 * with the work item context. Most callers leave the prompt as a draft; fix-check
 * launches can opt into submitting it after the TUI is ready.
 * Falls back to `openModalFallback()` when:
 *   - the repo's `setupRunPolicy` is `'ask'` (the user must pick per-workspace)
 *   - the repo can't be resolved from `repoId`
 *   - a PR head cannot be resolved
 *
 * Host-resolved: the client names only the requested agent identity, the
 * interactive prompt, and — for recipe launches — the source-control owner
 * locator (`sourceControlActionId`). The host resolves command/args/env and the
 * recipe's stored agentArgs, delivers the prompt, and spawns the primary agent
 * terminal; a pre-create rejection is `created: false` (no worktree), never a
 * thrown error. No agent resolves → the workspace opens bare (legacy no-agent
 * parity), and the agent identity still persists via `createdWithAgent` so an
 * empty-worktree reopen can recreate it.
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
    sourceControlActionId
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

  // Why: agent detection shells out and can be cold/slow. Start it now, but
  // don't let it serialize the setup/PR/draft preflights — it only has to
  // resolve before createWorktree, because the agent identity rides the host
  // `agentLaunch` request on the create call. Detection uses the repo's owner
  // connection, which the created worktree inherits.
  const detectedAgentsPromise = repoConnectionId
    ? store.ensureRemoteDetectedAgents(repoConnectionId)
    : store.ensureDetectedAgents()
  // Why: custom agents live in the local catalog, not in detection or settings,
  // so the selection below needs both before it can validate the request.
  const localAgentCatalogPromise = loadDirectLaunchAgentCatalog()

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

  const draftContent = await getDirectWorkItemDraftContent(item, repoConnectionId)
  // Why: resolve the requested agent identity before the create call so it can
  // ride the host `agentLaunch` request. The host owns command/args/env
  // resolution and prompt delivery; the client only names the agent — parity
  // with the new-workspace composer.
  const [detectedAgents, localAgentCatalog] = await Promise.all([
    detectedAgentsPromise,
    localAgentCatalogPromise
  ])
  const { requestedAgent, agentOverrideUnavailable } = resolveDirectLaunchAgent({
    agentOverride,
    detectedAgents,
    localAgentCatalog,
    settings
  })
  // Why: the host resolves the launch and spawns the primary agent terminal, so
  // the request carries only the agent identity, the interactive prompt (host
  // applies its per-surface max), the draft-vs-submit policy, and — for recipe
  // launches — the owner locator whose stored agentArgs the host resolves. No
  // request is sent when no agent resolved; the workspace opens bare.
  const agentLaunch: AgentLaunchSpawnRequest | undefined = requestedAgent
    ? {
        selection: { kind: 'agent', agent: requestedAgent },
        ...(draftContent.trim() ? { prompt: draftContent } : {}),
        ...(promptDelivery === 'draft' ? { promptDelivery: 'draft' as const } : {}),
        allowEmptyPromptLaunch: true,
        ...(sourceControlActionId
          ? { sourceRecord: { owner: 'source-control-recipe' as const, id: sourceControlActionId } }
          : {})
      }
    : undefined

  let worktreeId: string
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
      // Why: persist the chosen agent so an empty-worktree reopen can recreate it.
      requestedAgent ?? undefined,
      item.linearIdentifier,
      resolvedBranchNameOverride,
      undefined,
      itemType === 'mr' && itemNumber ? itemNumber : undefined,
      gitLabIssueNumber({ ...item, type: itemType, number: itemNumber }),
      // The host owns startup resolution via `agentLaunch`; the legacy
      // self-contained startup arg is never used on the create path.
      undefined,
      undefined,
      undefined,
      item.linearWorkspaceId,
      item.linearOrganizationUrlKey,
      undefined,
      undefined,
      undefined,
      resolvedCompareBaseRef,
      // Surface-owned agent_started fields for the host-emitted create; the host
      // derives agent_kind from the resolved receipt and fires the event itself.
      agentLaunch
        ? {
            agentLaunch,
            agentLaunchTelemetry: { launch_source: launchSource, request_kind: 'new' }
          }
        : undefined
    )
    if (result.created === false) {
      // A pre-create agent-launch rejection created no worktree; surface the
      // client-safe recovery copy and keep the caller's fallback path intact.
      const rejection = result.agentLaunchResult
      toast.error(
        rejection.status === 'failed'
          ? agentLaunchFailureMessage(rejection.failure)
          : agentLaunchRequestErrorMessage(rejection.requestError)
      )
      return false
    }
    worktreeId = result.worktree.id

    const activation = activateAndRevealWorktree(worktreeId, {
      sidebarRevealBehavior: 'auto',
      setup: result.setup,
      defaultTabs: result.defaultTabs,
      // The host spawned the primary agent terminal; suppress the client
      // reopen/auto-create so the renderer never spawns a duplicate.
      ...(agentLaunch ? { backendStartupTerminalSpawned: true } : {})
    })
    if (!activation) {
      // Worktree vanished between create and activate — extremely unlikely but
      // worth handling explicitly rather than silently opening nothing.
      toast.error(workspaceActivationErrorMessage())
      return false
    }
    if (activation.primaryTabId && requestedAgent && promptDelivery === 'draft') {
      const draft = draftContent.trim()
      if (draft) {
        seedNativeChatLaunchDraftForAgentTab({
          tabId: activation.primaryTabId,
          agent: requestedAgent,
          text: draftContent
        })
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace.'
    toast.error(message)
    return false
  }

  store.setSidebarOpen(true)

  if (agentOverrideUnavailable) {
    // Why: the workspace is live but the explicitly requested agent isn't
    // available on this host, so it opened bare — tell the user rather than
    // silently launching a different agent.
    toast.error(unavailableAgentErrorMessage())
    return false
  }
  return true
}
