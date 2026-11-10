import { prepareWorktreeCreationHooks, setupCreateArgs } from './worktree-creation-hook-preparation'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import type { ActivateAndRevealResult } from '@/lib/workspace/activation/worktree-activation-outcome'
import { ensureWorktreeHasInitialTerminal } from '@/lib/workspace/activation/initial-surface/worktree-initial-terminal-seeding'
import {
  attachEphemeralVmRuntimeToWorkspace,
  cleanupEphemeralVmRuntimeForFailedCreate,
  prepareRequestForCreate
} from '@/lib/workspace/creation/ephemeral-vm-worktree-creation'
import { getProvisionedRootCreateOptions } from '@/lib/workspace/creation/provisioned-root-create-options'
import { releaseVmCreateCheckout } from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace/creation/workspace-create-error-format'
import type { CreatedWorktreeResult } from '@/store/slices/worktrees/create/worktree-create-payload'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { resolveBackendDraftStartup } from '@/lib/workspace/creation/worktree-draft-startup-view-mode'
import {
  recoverWorktreeLegacyPreparation,
  hostPlannableAgentLaunch,
  worktreeCreationAgentLaunchOptions,
  windowStartupAfterCreate
} from '@/lib/workspace/creation/worktree-creation-host-agent-launch'
import {
  launchStructuredWorktreeSession,
  type WorktreeCreationStructuredSessionResult
} from '@/lib/workspace/creation/worktree-creation-structured-session'
import { completeWorktreeCreation } from '@/lib/workspace/creation/worktree-creation-completion'
import { showWorktreeCreationReadyToast } from '@/lib/workspace/creation/worktree-creation-ready-toast'
import { mountCreatedWorktreeStartupTabsInBackground } from '@/lib/workspace/creation/worktree-creation-background-mount'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/runtime/hosted-terminals/restoration/web-runtime-worktree-terminal-after-wake'
import {
  isCreatedWorkspaceInView,
  showWorktreeCreationError
} from '@/lib/workspace/creation/worktree-creation-surface'
import { prepareCreatedWorktreeActivation } from '@/lib/workspace/creation/worktree-creation-initial-tabs'
import type { UISlice } from '@/store/slices/ui/ui-slice-contract'

export async function executeWorktreeCreation(
  creationId: string,
  request: WorktreeCreationRequest,
  originView: UISlice['activeView'] = 'terminal'
): Promise<void> {
  const trustedRequest = request.hookPreparation
    ? await prepareWorktreeCreationHooks(creationId, request)
    : request
  const preparedRequest =
    trustedRequest && (await prepareRequestForCreate(creationId, trustedRequest))
  if (!preparedRequest) {
    return
  }

  const structuredLaunch = preparedRequest.agentLaunchRoute === 'structured-native-chat'
  const creationHostId =
    preparedRequest.workspaceRunContext?.hostId ?? preparedRequest.executionHostId
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
          ...setupCreateArgs(preparedRequest),
          ...(preparedRequest.branchIntent ? { branchIntent: preparedRequest.branchIntent } : {}),
          ...(hostAgentLaunch ? { hostAgentLaunch } : {}),
          ...worktreeCreationAgentLaunchOptions(preparedRequest),
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
            : {}),
          ...(preparedRequest.note ? { note: preparedRequest.note } : {})
        }
      )
  } catch (error) {
    // Missing entry means mid-flight user cancellation; stop silently instead of reporting dismissed work as failure.
    if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
      return
    }
    if (preparedRequest.ephemeralVmRuntimeId) {
      await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest, creationId)
    }
    if (recoverWorktreeLegacyPreparation(creationId, preparedRequest, error)) {
      return
    }
    const message = getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error))
    showWorktreeCreationError(
      useAppStore.getState(),
      creationId,
      originView,
      message,
      preparedRequest.ephemeralVmRecipe ? request : undefined
    )
    return
  }

  const worktree = result.worktree
  // Why: cancellation can race a successful backend adoption; clean up again after it settles so an adopted workspace cannot outlive its destroyed VM.
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    if (preparedRequest.ephemeralVmRuntimeId) {
      await cleanupEphemeralVmRuntimeForFailedCreate(preparedRequest, creationId)
    }
    return
  }
  // The VM's checkout is now this workspace (or its project), so the sidebar may list it.
  releaseVmCreateCheckout(creationId)
  await attachEphemeralVmRuntimeToWorkspace(preparedRequest, worktree.id)

  const backendSpawned = result.startupTerminal?.spawned === true
  const windowStartup = windowStartupAfterCreate(creationId, preparedRequest, result)
  const startupOpt = windowStartup.startup

  // Hand off only if still viewing creation/new workspace; preserve later navigation and toast instead (#9944).
  const shouldActivateOnCompletion = isCreatedWorkspaceInView(
    useAppStore.getState(),
    creationId,
    worktree.id,
    originView
  )
  const setupIsOnlySurface = preparedRequest.setupOnly === true && result.setup !== undefined
  const defaultTabs = setupIsOnlySurface ? undefined : result.defaultTabs

  let activation: ActivateAndRevealResult | false = false
  let primaryTabId: string | null = null
  if (shouldActivateOnCompletion && !structuredLaunch) {
    try {
      const prepared = prepareCreatedWorktreeActivation({
        creationId,
        request: preparedRequest,
        result,
        windowStartup,
        defaultTabs,
        setupIsOnlySurface,
        executionHostId: creationHostId
      })
      primaryTabId = prepared.primaryTabId
      activation = activateAndRevealWorktree(worktree.id, prepared.options)
      primaryTabId ??= activation === false ? null : activation.primaryTabId
    } catch (error) {
      console.error('worktree create: activate-and-reveal failed', worktree.id, error)
      // Activation can publish then throw; only freshly seeded/stamped startup tabs prove primary ownership, never default order.
      const stateAfterActivationFailure = useAppStore.getState()
      const existingTabs = stateAfterActivationFailure.tabsByWorktree[worktree.id] ?? []
      const launchAgent = startupOpt?.launchAgent ?? preparedRequest.agent
      const verifiedLaunchTabId =
        result.startupTerminal?.tabId ??
        (launchAgent ? existingTabs.find((tab) => tab.launchAgent === launchAgent)?.id : undefined)
      if (verifiedLaunchTabId && !primaryTabId) {
        // Startup terminal ids and stamped agent tabs are the only safe primary
        // ids when activation returned no result.
        primaryTabId = verifiedLaunchTabId
      } else if (!primaryTabId && (existingTabs.length === 0 || startupOpt)) {
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
          console.error('worktree create: after-wake recovery failed', worktree.id, recoveryError)
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
      if (structuredSession.cancelled || structuredSession.retainedInput) {
        return
      }
    }
  }

  if (!shouldActivateOnCompletion && useAppStore.getState().pendingWorktreeCreations[creationId]) {
    showWorktreeCreationReadyToast(worktree, creationHostId)
  }

  await completeWorktreeCreation({
    creationId,
    request: preparedRequest,
    worktreeId: worktree.id,
    structuredLaunchAccepted,
    activation,
    primaryTabId,
    startupTerminalTabId: result.startupTerminal?.tabId,
    startupAgent: result.worktree.createdWithAgent ?? undefined,
    backendSpawned,
    hostPlannedStartup: result.hostPlannedStartup === true,
    focusOnCompletion: shouldActivateOnCompletion
  })
}
