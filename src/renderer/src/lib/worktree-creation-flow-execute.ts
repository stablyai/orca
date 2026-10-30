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
import type { CreatedWorktreeResult } from '@/store/slices/worktrees/create/worktree-create-payload'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { resolveBackendDraftStartup } from '@/lib/worktree-draft-startup-view-mode'
import {
  hostPlannableAgentLaunch,
  windowStartupAfterCreate
} from '@/lib/worktree-creation-host-agent-launch'
import {
  launchStructuredWorktreeSession,
  type WorktreeCreationStructuredSessionResult
} from '@/lib/worktree-creation-structured-session'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { showWorktreeCreationReadyToast } from '@/lib/worktree-creation-ready-toast'
import { mountCreatedWorktreeStartupTabsInBackground } from '@/lib/worktree-creation-background-mount'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'

// The pending pointer can survive app-view changes; only terminal view actually displays creation UI.
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

  const structuredLaunch = preparedRequest.agentLaunchRoute === 'structured-native-chat'
  const creationHostId =
    preparedRequest.workspaceRunContext?.hostId ?? preparedRequest.executionHostId
  // Named to later steps, so a same-path twin on another host can't blur the owner (L277).
  const onCreationHost = creationHostId ? { executionHostId: creationHostId } : {}
  const hostAgentLaunch = hostPlannableAgentLaunch(preparedRequest)
  let result: CreatedWorktreeResult
  try {
    const provisionedRoot = getProvisionedRootCreateOptions(preparedRequest)
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
          setupOnly: preparedRequest.setupOnly,
          ...(preparedRequest.branchIntent ? { branchIntent: preparedRequest.branchIntent } : {}),
          ...(hostAgentLaunch ? { hostAgentLaunch } : {}),
          executionHostId: creationHostId,
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
    // Missing entry means mid-flight user cancellation; stop silently instead of reporting dismissed work as failure.
    if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
      return
    }
    if (preparedRequest.ephemeralVmRuntimeId) {
      await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest)
    }
    const message = getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error))
    // Keep failures on the owning creation surface, never stale previous-workspace tabs.
    useAppStore.getState().updatePendingWorktreeCreation(creationId, {
      status: 'error',
      error: message,
      ...(preparedRequest.ephemeralVmRecipe ? { request } : {})
    })
    // Toast only after navigation away; inline errors already announce visible failures.
    if (!isPendingCreationSurfaceVisible(creationId)) {
      toast.error(message)
    }
    return
  }

  const worktree = result.worktree
  // Why: cancellation can race a successful backend adoption; clean up again after it settles so an adopted workspace cannot outlive its destroyed VM.
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    if (preparedRequest.ephemeralVmRuntimeId) {
      await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest)
    }
    return
  }
  await attachEphemeralVmRuntimeToWorkspace(preparedRequest, worktree.id)

  const backendSpawned = result.startupTerminal?.spawned === true
  const windowStartup = windowStartupAfterCreate(creationId, preparedRequest, result)
  const startupOpt = windowStartup.startup

  // Hand off only if still viewing creation/new workspace; preserve later navigation and toast instead (#9944).
  const shouldActivateOnCompletion = isCreatedWorkspaceInView(creationId, worktree.id)
  const setupIsOnlySurface = preparedRequest.setupOnly === true && result.setup !== undefined
  const defaultTabs = setupIsOnlySurface ? undefined : result.defaultTabs

  // Contain post-create follow-ups independently; fire-and-forget throws otherwise strand creation UI over a completed workspace.
  let activation: ActivateAndRevealResult | false = false
  let primaryTabId: string | null = null
  if (shouldActivateOnCompletion && !structuredLaunch) {
    try {
      activation = activateAndRevealWorktree(worktree.id, {
        sidebarRevealBehavior: 'auto',
        ...onCreationHost,
        ...(windowStartup.agent !== null ? { agent: windowStartup.agent } : {}),
        ...(result.setup ? { setup: result.setup } : {}),
        ...(defaultTabs ? { defaultTabs } : {}),
        ...(startupOpt ? { startup: startupOpt } : {}),
        ...(preparedRequest.issueCommand ? { issueCommand: preparedRequest.issueCommand } : {}),
        ...windowStartup.terminalOptions,
        ...(setupIsOnlySurface ? { providesInitialSurface: true } : {})
      })
      primaryTabId = activation === false ? null : activation.primaryTabId
    } catch (error) {
      console.error('worktree create: activate-and-reveal failed', worktree.id, error)
      // Activation can publish then throw; only freshly seeded/stamped startup tabs prove primary ownership, never default order.
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
      } else if (existingTabs.length === 0 || startupOpt) {
        try {
          primaryTabId = ensureWorktreeHasInitialTerminal(
            useAppStore.getState(),
            worktree.id,
            startupOpt,
            result.setup,
            preparedRequest.issueCommand,
            defaultTabs,
            // Activation failed before providing its promised surface, so recovery must seed one.
            { ...onCreationHost, ...windowStartup.terminalOptions }
          )
        } catch (recoveryError) {
          console.error('worktree create: recovery seed failed', worktree.id, recoveryError)
        }
      }
      if (!backendSpawned) {
        try {
          ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id, {
            startup: startupOpt,
            agent: windowStartup.agent,
            unknownHostCountIsEmpty: true
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
      startupOpt || result.setup || preparedRequest.issueCommand || defaultTabs
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
          defaultTabs,
          {
            activateCreatedTabs: false,
            ...onCreationHost,
            ...(callerProvidesSurface ? { callerProvidesSurface: true } : {}),
            ...windowStartup.terminalOptions
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
          agent: windowStartup.agent,
          activate: false,
          // Why: this client just created the workspace, so it starts empty.
          unknownHostCountIsEmpty: true
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
      // Guard plan.launch’s synchronous prologue too; treat escaped failure as accepted and still finish creation.
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
      showWorktreeCreationReadyToast(worktree, creationHostId)
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
    hostPlannedStartup: result.hostPlannedStartup === true,
    focusOnCompletion: shouldActivateOnCompletion
  })
}
