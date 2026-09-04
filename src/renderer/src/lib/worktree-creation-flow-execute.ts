import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { preflightAgentTrust as preflightWorkspaceAgentTrust } from '@/lib/agent-trust-preflight'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import {
  attachEphemeralVmRuntimeToWorkspace,
  cleanupEphemeralVmRuntimeForFailedCreate,
  prepareRequestForCreate
} from '@/lib/ephemeral-vm-worktree-creation'
import { getProvisionedRootCreateOptions } from '@/lib/provisioned-root-create-options'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { resolveBackendDraftStartup } from '@/lib/worktree-draft-startup-view-mode'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { launchStructuredWorktreeSession } from '@/lib/worktree-creation-structured-session'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { markStructuredWorktreeLaunchUnconfirmed } from '@/lib/worktree-creation-structured-recovery'

// Why: activePendingCreationId can outlive the terminal route when the user
// switches app views; only the terminal route renders the creation panel.
function isPendingCreationSurfaceVisible(creationId: string): boolean {
  const state = useAppStore.getState()
  return state.activeView === 'terminal' && state.activePendingCreationId === creationId
}

async function preflightAgentTrust(
  request: WorktreeCreationRequest,
  path: string,
  connectionId?: string | null
): Promise<void> {
  await preflightWorkspaceAgentTrust({
    agent: request.agent,
    workspacePath: path,
    connectionId
  })
}

export async function executeWorktreeCreation(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<void> {
  const preparedRequest = await prepareRequestForCreate(creationId, request)
  if (!preparedRequest) {
    return
  }

  let result: CreateWorktreeResult
  try {
    const provisionedRoot = getProvisionedRootCreateOptions(preparedRequest)
    const structuredLaunch = preparedRequest.agentLaunchRoute === 'structured-native-chat'
    const backendStartup =
      provisionedRoot || structuredLaunch ? undefined : resolveBackendDraftStartup(preparedRequest)
    result = await useAppStore
      .getState()
      .createWorktree(
        preparedRequest.repoId,
        preparedRequest.name,
        preparedRequest.baseBranch,
        preparedRequest.setupDecision,
        preparedRequest.sparseCheckout,
        preparedRequest.telemetrySource,
        preparedRequest.displayName,
        preparedRequest.linkedIssue,
        preparedRequest.linkedPR,
        preparedRequest.pushTarget,
        preparedRequest.agent ?? undefined,
        preparedRequest.linkedLinearIssue,
        preparedRequest.branchNameOverride,
        preparedRequest.workspaceStatus,
        preparedRequest.linkedGitLabMR,
        preparedRequest.linkedGitLabIssue,
        backendStartup,
        structuredLaunch ? false : preparedRequest.pendingFirstAgentMessageRename,
        creationId,
        preparedRequest.linkedLinearIssueWorkspaceId,
        preparedRequest.linkedLinearIssueOrganizationUrlKey,
        preparedRequest.linkedBitbucketPR,
        preparedRequest.linkedAzureDevOpsPR,
        preparedRequest.linkedGiteaPR,
        preparedRequest.compareBaseRef,
        {
          ...(preparedRequest.nameWasGenerated ? { nameWasGenerated: true } : {}),
          ...(preparedRequest.displayNameKind
            ? { displayNameKind: preparedRequest.displayNameKind }
            : {}),
          ...(preparedRequest.linkedWorkItem !== undefined
            ? { linkedWorkItem: preparedRequest.linkedWorkItem }
            : {}),
          ...(preparedRequest.linkedTaskSourceContext !== undefined
            ? { linkedTaskSourceContext: preparedRequest.linkedTaskSourceContext }
            : {}),
          // Why: the remote host must own task-draft startup so its initial terminal is the agent, not an idle fallback shell.
          ...(!structuredLaunch &&
          !backendStartup &&
          preparedRequest.agent &&
          preparedRequest.launchDraftPrompt
            ? { startupDraft: preparedRequest.launchDraftPrompt }
            : {}),
          ...(provisionedRoot ? { provisionedRoot } : {}),
          ...(preparedRequest.parentWorktreeId
            ? { parentWorktreeId: preparedRequest.parentWorktreeId }
            : {})
        }
      )
  } catch (error) {
    // Why: a missing entry means the user cancelled mid-flight — abandon
    // silently rather than surfacing an error for work they already dismissed.
    if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
      return
    }
    if (preparedRequest.ephemeralVmRuntimeId) {
      await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest)
    }
    const message = getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error))
    // Why: an error must stay on the same creation surface that owns the faux
    // tab strip, rather than falling back to stale previous-workspace tabs.
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: message,
      ...(preparedRequest.ephemeralVmRecipe ? { request } : {})
    })
    // Why: only toast when the panel isn't already showing this error (the user
    // navigated away), so a visible failure isn't announced twice.
    if (!isPendingCreationSurfaceVisible(creationId)) {
      toast.error(message)
    }
    return
  }

  const worktree = result.worktree
  const structuredLaunch = preparedRequest.agentLaunchRoute === 'structured-native-chat'
  // Why: cancellation can race a successful backend adoption; clean up again after it settles so an adopted workspace cannot outlive its destroyed VM.
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    if (preparedRequest.ephemeralVmRuntimeId) {
      await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest)
    }
    return
  }
  await attachEphemeralVmRuntimeToWorkspace(preparedRequest, worktree.id)

  const backendSpawned = result.startupTerminal?.spawned === true
  if (preparedRequest.startupPlan && !backendSpawned && !preparedRequest.startupPlan.launchToken) {
    // Why: delayed delivery must target the exact pane spawned from this queued
    // startup, so both halves of the handoff share one renderer-session token.
    preparedRequest.startupPlan.launchToken = createBrowserUuid()
  }
  const fallbackStartupOpt = buildWorktreeCreationStartupOpt(preparedRequest, backendSpawned)
  const startupOpt = structuredLaunch ? undefined : fallbackStartupOpt

  if (worktree.path && !structuredLaunch) {
    const repoConnectionId =
      useAppStore.getState().repos.find((repo) => repo.id === worktree.repoId)?.connectionId ?? null
    await preflightAgentTrust(preparedRequest, worktree.path, repoConnectionId)
  }

  // `createWorktree` already inserted the real worktree row. Leaving for an app
  // view keeps the create in the background, while selecting another workspace
  // means the user still expects this task-launch handoff when it becomes ready;
  // the entry guard prevents a late trust preflight from reviving a cancelled create.
  const completionState = useAppStore.getState()
  const shouldActivateOnCompletion =
    completionState.pendingWorktreeCreations[creationId] !== undefined &&
    (isPendingCreationSurfaceVisible(creationId) ||
      (completionState.activeView === 'terminal' &&
        completionState.activePendingCreationId === null))

  let activation: ActivateAndRevealResult | false = false
  let primaryTabId: string | null
  if (shouldActivateOnCompletion) {
    activation = activateAndRevealWorktree(worktree.id, {
      sidebarRevealBehavior: 'auto',
      ...(result.setup ? { setup: result.setup } : {}),
      ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
      ...(startupOpt ? { startup: startupOpt } : {}),
      ...(preparedRequest.issueCommand ? { issueCommand: preparedRequest.issueCommand } : {}),
      ...(backendSpawned ? { backendStartupTerminalSpawned: true } : {}),
      ...(structuredLaunch ? { providesInitialSurface: true } : {})
    })
    primaryTabId = activation === false ? null : activation.primaryTabId
  } else {
    // The user moved on. Seed the worktree's terminal + setup in the background
    // (setActiveTab only writes global focus for the active worktree, so this is
    // safe) without yanking them back to it.
    const hasExplicitTerminalWork = Boolean(
      startupOpt || result.setup || preparedRequest.issueCommand || result.defaultTabs
    )
    primaryTabId =
      structuredLaunch && !hasExplicitTerminalWork
        ? null
        : ensureWorktreeHasInitialTerminal(
            useAppStore.getState(),
            worktree.id,
            startupOpt,
            result.setup,
            preparedRequest.issueCommand,
            result.defaultTabs,
            {
              activateCreatedTabs: false,
              ...(backendSpawned ? { backendStartupTerminalSpawned: true } : {})
            }
          )
  }

  let structuredLaunchAccepted = structuredLaunch
  if (structuredLaunch && preparedRequest.agent === 'codex') {
    const structuredSession = await launchStructuredWorktreeSession({
      creationId,
      request: preparedRequest,
      worktreeId: worktree.id,
      shouldActivateOnCompletion,
      fallbackStartupOpt,
      activation,
      primaryTabId
    })
    structuredLaunchAccepted = structuredSession.accepted
    activation = structuredSession.activation
    primaryTabId = structuredSession.primaryTabId
    if (structuredSession.cancelled) {
      return
    }
    if (structuredSession.visibilityUnknown) {
      markStructuredWorktreeLaunchUnconfirmed(creationId, worktree.id)
      return
    }
  }

  await completeWorktreeCreation({
    creationId,
    request: preparedRequest,
    worktreeId: worktree.id,
    structuredLaunchAccepted,
    activation,
    primaryTabId,
    startupTerminalTabId: result.startupTerminal?.tabId,
    backendSpawned,
    focusOnCompletion: shouldActivateOnCompletion
  })
}
