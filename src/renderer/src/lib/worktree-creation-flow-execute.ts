import { prepareWorktreeCreationHooks } from '@/lib/worktree-creation-hook-preparation'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
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
import {
  launchStructuredWorktreeSession,
  type WorktreeCreationStructuredSessionResult
} from '@/lib/worktree-creation-structured-session'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { showWorktreeCreationReadyToast } from '@/lib/worktree-creation-ready-toast'
import { mountCreatedWorktreeStartupTabsInBackground } from '@/lib/worktree-creation-background-mount'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'

// Why: activePendingCreationId can outlive the terminal route when the user
// switches app views; only the terminal route renders the creation panel.
function isPendingCreationSurfaceVisible(creationId: string): boolean {
  const state = useAppStore.getState()
  return state.activeView === 'terminal' && state.activePendingCreationId === creationId
}

// Why: the created row is listed before completion, so a user may already have opened it.
function isCreatedWorkspaceInView(creationId: string, worktreeId: string): boolean {
  const state = useAppStore.getState()
  return (
    isPendingCreationSurfaceVisible(creationId) ||
    (state.activeView === 'terminal' &&
      state.activePendingCreationId === null &&
      state.activeWorktreeId === worktreeId)
  )
}

export async function executeWorktreeCreation(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<void> {
  const trustedRequest = request.hookPreparation
    ? await prepareWorktreeCreationHooks(creationId, request)
    : request
  if (!trustedRequest) {
    return
  }
  const preparedRequest = await prepareRequestForCreate(creationId, trustedRequest)
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
        preparedRequest.pendingFirstAgentMessageRename,
        creationId,
        preparedRequest.linkedLinearIssueWorkspaceId,
        preparedRequest.linkedLinearIssueOrganizationUrlKey,
        preparedRequest.linkedBitbucketPR,
        preparedRequest.linkedAzureDevOpsPR,
        preparedRequest.linkedGiteaPR,
        preparedRequest.compareBaseRef,
        {
          executionHostId:
            preparedRequest.workspaceRunContext?.hostId ?? preparedRequest.executionHostId,
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
  const startupOpt = structuredLaunch
    ? undefined
    : buildWorktreeCreationStartupOpt(preparedRequest, backendSpawned)

  // Why: only a user still watching the creation surface (or already on the new
  // workspace) is handed it; anyone who moved on (another workspace or an app
  // view) keeps their place and gets a toast instead (#9944).
  const shouldActivateOnCompletion = isCreatedWorkspaceInView(creationId, worktree.id)
  // Why: "None" leaves setup as the only surface; without a setup run it falls back to a shell.
  const setupIsOnlySurface = preparedRequest.setupOnly === true && result.setup !== undefined

  // Why: the worktree exists past this point and nothing awaits this caller, so
  // each follow-up step is best-effort — an escaped throw would strand the
  // creation surface over the finished workspace instead of reaching completion.
  let activation: ActivateAndRevealResult | false = false
  let primaryTabId: string | null = null
  if (shouldActivateOnCompletion && !structuredLaunch) {
    try {
      activation = activateAndRevealWorktree(worktree.id, {
        sidebarRevealBehavior: 'auto',
        ...(preparedRequest.agent !== null ? { agent: preparedRequest.agent } : {}),
        ...(result.setup ? { setup: result.setup } : {}),
        ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
        ...(startupOpt ? { startup: startupOpt } : {}),
        ...(preparedRequest.issueCommand ? { issueCommand: preparedRequest.issueCommand } : {}),
        ...(backendSpawned ? { backendStartupTerminalSpawned: true } : {}),
        ...(setupIsOnlySurface ? { providesInitialSurface: true } : {})
      })
      primaryTabId = activation === false ? null : activation.primaryTabId
    } catch (error) {
      console.error('worktree create: activate-and-reveal failed', worktree.id, error)
      // Activation can publish the worktree before a later step throws. Do not
      // infer a primary tab from default-tab ordering; only a fresh seed may
      // return one here.
      const stateAfterActivationFailure = useAppStore.getState()
      const existingTabs = stateAfterActivationFailure.tabsByWorktree[worktree.id] ?? []
      const launchAgent = startupOpt?.launchAgent ?? preparedRequest.agent
      const verifiedLaunchTabId =
        result.startupTerminal?.tabId ??
        (launchAgent ? existingTabs.find((tab) => tab.launchAgent === launchAgent)?.id : undefined)
      if (verifiedLaunchTabId) {
        // Startup terminal ids and stamped agent tabs are the only safe primary
        // ids when activation returned no result.
        primaryTabId = verifiedLaunchTabId
      } else if (existingTabs.length === 0) {
        try {
          primaryTabId = ensureWorktreeHasInitialTerminal(
            useAppStore.getState(),
            worktree.id,
            startupOpt,
            result.setup,
            preparedRequest.issueCommand,
            result.defaultTabs,
            // Activation failed before providing its promised surface, so recovery must seed one.
            backendSpawned ? { backendStartupTerminalSpawned: true } : undefined
          )
        } catch (recoveryError) {
          console.error(
            'worktree create: activation recovery seeding failed',
            worktree.id,
            recoveryError
          )
        }
      }
      if (!backendSpawned) {
        try {
          ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id, {
            startup: startupOpt,
            agent: preparedRequest.agent
          })
        } catch (recoveryError) {
          console.error(
            'worktree create: activation recovery after-wake seeding failed',
            worktree.id,
            recoveryError
          )
        }
      }
    }
  } else {
    // Why: backgrounded creates still need explicit setup/issue terminals, but must not activate them.
    const hasExplicitTerminalWork = Boolean(
      startupOpt || result.setup || preparedRequest.issueCommand || result.defaultTabs
    )
    const callerProvidesSurface = preparedRequest.agent !== null || setupIsOnlySurface
    if (preparedRequest.agent === null || hasExplicitTerminalWork) {
      try {
        primaryTabId = ensureWorktreeHasInitialTerminal(
          useAppStore.getState(),
          worktree.id,
          startupOpt,
          result.setup,
          preparedRequest.issueCommand,
          result.defaultTabs,
          {
            activateCreatedTabs: false,
            ...(callerProvidesSurface ? { callerProvidesSurface: true } : {}),
            ...(backendSpawned ? { backendStartupTerminalSpawned: true } : {})
          }
        )
      } catch (error) {
        console.error('worktree create: initial terminal seeding failed', worktree.id, error)
      }
      try {
        mountCreatedWorktreeStartupTabsInBackground(worktree.id)
      } catch (error) {
        console.error('worktree create: background terminal mount failed', worktree.id, error)
      }
    }
    if (!structuredLaunch && !backendSpawned) {
      try {
        ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id, {
          startup: startupOpt,
          agent: preparedRequest.agent,
          activate: false
        })
      } catch (error) {
        console.error('worktree create: after-wake terminal seeding failed', worktree.id, error)
      }
    }
  }

  let structuredLaunchAccepted = structuredLaunch
  const { agentLaunchRoute } = preparedRequest
  if (agentLaunchRoute === 'structured-native-chat' && preparedRequest.agent) {
    let structuredSession: WorktreeCreationStructuredSessionResult | null = null
    try {
      structuredSession = await launchStructuredWorktreeSession({
        creationId,
        request: preparedRequest,
        agentLaunchRoute,
        worktreeId: worktree.id,
        shouldActivateOnCompletion,
        activation,
        primaryTabId
      })
    } catch (error) {
      // Why: plan.launch is guarded inside, but its sync prologue is not; treat
      // an escaped throw like a failed launch (accepted) and still complete.
      console.error('worktree create: structured session launch failed', worktree.id, error)
    }
    if (structuredSession) {
      structuredLaunchAccepted = structuredSession.accepted
      activation = structuredSession.activation
      primaryTabId = structuredSession.primaryTabId
      if (structuredSession.cancelled) {
        return
      }
    }
  }

  if (!shouldActivateOnCompletion && useAppStore.getState().pendingWorktreeCreations[creationId]) {
    try {
      showWorktreeCreationReadyToast(worktree)
    } catch (error) {
      console.error('worktree create: ready toast failed', worktree.id, error)
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
