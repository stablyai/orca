import { showFolderWorkspaceSetupOutcome } from './folder-workspace-setup-feedback'
import { buildFolderWorkspaceStartupPayload } from './folder-workspace-startup-payload'
import { reviewSetupTrustMismatch } from '@/store/slices/worktrees/create/created-worktree-setup-trust'
import { projectGroupHookTrustKey } from '../../../../../../shared/workspace-hook-owner'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import { toAgentLaunchPreferences } from '../../../../../../shared/agent-launch/choices/agent-launch-preferences'
import { resolveAgentStartupPlanInputs } from '../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { ensureAgentStartupInTerminal } from '@/lib/workspace/creation/new-workspace'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-session/launch/prompt/agent-launch-prompt-delivery'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'
import { buildAgentStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-startup'
import '@/diagnostics/telemetry/telemetry'
import { activateAndRevealFolderWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import './folder-workspace-source-repos'
import {
  resolveFolderWorkspaceName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-source-selection'
import {
  planAgentSessionLaunch,
  adoptAgentSessionLaunchVerdict
} from '@/lib/agent-session/launch/routing/agent-session-launch-plan'

import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import '@/lib/workspace/creation/new-workspace-project-options'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { resolveExecutionHostAgentStartupShell } from '@/runtime/hosts/platform/execution-host-facts'
import {
  buildFolderWorkspaceLinkedStartupPlan,
  getFolderWorkspaceAgentLaunchFact,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-agent-startup'

import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import type { SubmitFolderWorkspaceCreateParams } from './folder-workspace-composer-submit-input'

export async function submitFolderWorkspaceCreate({
  projectGroup,
  setupSupported = false,
  setupApproval,
  isCancelled = () => false,
  name,
  lastAutoName,
  linkedWorkItem,
  linkedTaskSourceContext,
  note,
  quickAgent,
  launchChoice,
  launchInputs,
  legacyLaunchInputs,
  sessionOptions: requestedSessionOptions,
  chatSessionOptions: requestedChatSessionOptions,
  autoRenameBranchFromWork,
  settings,
  agentCmdOverrides,
  agentArgs: requestedAgentArgs,
  agentEnv,
  terminalWindowsShell,
  launchSource = 'sidebar',
  runtimeEnvironmentId = null,
  createFolderWorkspace,
  onOpenChange
}: SubmitFolderWorkspaceCreateParams): Promise<boolean> {
  const legacyInputs = legacyLaunchInputs ?? launchInputs
  const agentArgs = legacyInputs ? legacyInputs.agentArgs : requestedAgentArgs
  const sessionOptions = launchInputs ? launchInputs.sessionOptions : requestedSessionOptions
  const chatSessionOptions = launchInputs
    ? launchInputs.chatSessionOptions
    : requestedChatSessionOptions
  const workspaceName = resolveFolderWorkspaceName({
    projectGroup,
    name,
    lastAutoName,
    linkedWorkItem
  })
  const launchHost = getFolderWorkspaceAgentLaunchFact(useAppStore.getState(), projectGroup)
  if (quickAgent && launchHost.kind === 'withheld') {
    throw new Error(launchHost.reason)
  }
  const launchPlatform = launchHost.kind === 'known' ? launchHost.platform : null
  // SSH folders use the plain orca relay shim; keep the Linux-only local executable rename out of remote launches.
  const launchIsRemote = Boolean(projectGroup.connectionId)
  const launchShell = resolveExecutionHostAgentStartupShell(launchHost, terminalWindowsShell)
  const preferences =
    quickAgent && settings
      ? await ensureAgentLaunchPreferences(useAppStore.getState(), {
          kind: 'folder',
          runtimeEnvironmentId,
          executionHostId: getRepoExecutionHostId(projectGroup)
        })
      : undefined
  const effectiveSettings = settings
    ? {
        ...settings,
        agentLaunchChoices: launchInputs
          ? {}
          : (preferences?.agentLaunchChoices ?? settings.agentLaunchChoices)
      }
    : settings
  const startupPlan =
    quickAgent && launchPlatform && linkedWorkItem
      ? buildFolderWorkspaceLinkedStartupPlan({
          agent: quickAgent,
          settings: effectiveSettings,
          linkedWorkItem,
          note,
          agentCmdOverrides,
          agentArgs,
          sessionOptions,
          agentEnv,
          platform: launchPlatform,
          shell: launchShell,
          isRemote: launchIsRemote
        })
      : quickAgent && launchPlatform
        ? buildAgentStartupPlan({
            ...resolveAgentStartupPlanInputs({
              agent: quickAgent,
              settings: effectiveSettings ?? { agentCmdOverrides },
              agentArgs: settings ? agentArgs : (agentArgs ?? null),
              sessionOptions,
              platform: launchPlatform,
              shell: launchShell,
              isRemote: launchIsRemote
            }),
            ...(agentEnv ? { agentEnv } : {}),
            prompt: note,
            allowEmptyPromptLaunch: true
          })
        : null
  // Argv prefill embeds the draft in launchCommand, so draftPrompt alone cannot detect it.
  const launchDraftPrompt =
    quickAgent && linkedWorkItem ? resolveFolderWorkspaceLaunchDraft(linkedWorkItem, note) : null
  const launchRequest = quickAgent
    ? {
        requestId: createBrowserUuid(),
        agent: quickAgent,
        ...(sessionOptions ? { launchOptions: sessionOptions } : {}),
        ...(chatSessionOptions !== undefined ? { chatLaunchOptions: chatSessionOptions } : {}),
        workspace: {
          kind: 'folder' as const,
          runtimeEnvironmentId,
          executionHostId: getRepoExecutionHostId(projectGroup)
        },
        prompt: launchDraftPrompt ?? note,
        promptDelivery: launchDraftPrompt ? ('draft' as const) : ('auto-submit' as const)
      }
    : null
  // Creation retains its chosen route, but admission after materialization may fall back.
  const plan = launchRequest
    ? launchChoice
      ? adoptAgentSessionLaunchVerdict({
          ...launchRequest,
          route: launchChoice.route,
          executionHostId: launchChoice.executionHostId
        })
      : planAgentSessionLaunch(useAppStore.getState(), launchRequest)
    : null
  const structuredLaunch = plan?.route === 'structured-native-chat'
  if (quickAgent && !structuredLaunch && !startupPlan) {
    throw new Error(
      translate(
        'agentPicker.workspaceStartupFailed',
        'Could not start {{agent}}. Check Arguments in this setup and try again.',
        { agent: getAgentLabel(quickAgent) }
      )
    )
  }
  // Show pending rename only when the submitted prompt can produce a naming message.
  const pendingFirstAgentMessageRename =
    autoRenameBranchFromWork === true &&
    !name.trim() &&
    !linkedWorkItem &&
    Boolean(quickAgent) &&
    note.trim().length > 0

  if (startupPlan && !startupPlan.launchToken) {
    startupPlan.launchToken = createBrowserUuid()
  }
  const hostStartsTerminal = setupSupported && Boolean(runtimeEnvironmentId) && !structuredLaunch
  const result = await createFolderWorkspace({
    ...(setupSupported ? setupApproval : {}),
    ...(setupSupported && structuredLaunch ? { agentLaunchMode: 'structured' as const } : {}),
    ...(hostStartsTerminal && startupPlan
      ? {
          startupCommand: startupPlan.launchCommand,
          startupEnv: startupPlan.env,
          startupLaunchConfig: startupPlan.launchConfig,
          startupCommandDelivery: startupPlan.startupCommandDelivery,
          startupAgent: quickAgent ?? undefined,
          startupPrompt: launchDraftPrompt ?? note,
          startupAgentArgs: agentArgs,
          startupSessionOptions: sessionOptions,
          startupLaunchPreferences: quickAgent
            ? toAgentLaunchPreferences(sessionOptions, quickAgent)
            : undefined,
          launchSource
        }
      : {}),
    projectGroupId: projectGroup.id,
    name: workspaceName,
    // Retain the SSH target even when another host owns the focused runtime.
    connectionId: projectGroup.connectionId ?? null,
    linkedTask: toFolderWorkspaceLinkedTask(linkedWorkItem),
    ...(linkedTaskSourceContext ? { linkedTaskSourceContext } : {}),
    ...(quickAgent ? { createdWithAgent: quickAgent } : {}),
    ...(pendingFirstAgentMessageRename ? { pendingFirstAgentMessageRename: true } : {})
  })
  if (!result) {
    return false
  }
  const workspace = result.folderWorkspace
  reviewSetupTrustMismatch(
    useAppStore.getState,
    projectGroupHookTrustKey(projectGroup),
    getRepoExecutionHostId(projectGroup),
    { ...result, worktree: folderWorkspaceToWorktree(workspace) },
    runtimeEnvironmentId
      ? { kind: 'environment', environmentId: runtimeEnvironmentId }
      : { kind: 'local' }
  )
  const launchFailed = result.agentLaunchOutcome?.status === 'failed' || isCancelled()

  const startup = buildFolderWorkspaceStartupPayload({
    quickAgent,
    startupPlan,
    launchInputs,
    requestedAgentArgs,
    sessionOptions,
    launchDraftPrompt,
    note,
    launchSource
  })
  showFolderWorkspaceSetupOutcome(result, quickAgent, isCancelled())
  onOpenChange(false)
  try {
    const activationHolder: {
      value: ReturnType<typeof activateAndRevealFolderWorkspace>
    } = { value: false }
    const revealWorkspace = (): boolean => {
      activationHolder.value = activateAndRevealFolderWorkspace(workspace.id, {
        agent: launchFailed ? null : quickAgent,
        ...(!launchFailed && !structuredLaunch && !hostStartsTerminal && startup
          ? { startup }
          : {}),
        ...(result.setup ? { setup: result.setup } : {}),
        backendStartupTerminalSpawned: result.startupTerminal?.spawned === true,
        ...(!launchFailed && structuredLaunch ? { providesInitialSurface: true } : {}),
        runtimeEnvironmentId
      })
      return activationHolder.value !== false
    }
    if (!launchFailed && plan?.route === 'structured-native-chat') {
      beginStructuredAgentSessionProvisionalLaunch({
        plan,
        hooks: {},
        declinedTerminal: { agentArgs },
        target: { worktreeId: folderWorkspaceKey(workspace.id) },
        beforeOpen: revealWorkspace
      })
    } else {
      revealWorkspace()
    }
    const activation = activationHolder.value
    if (
      !launchFailed &&
      !hostStartsTerminal &&
      !structuredLaunch &&
      quickAgent &&
      startupPlan &&
      launchDraftPrompt &&
      activation !== false &&
      activation.primaryTabId
    ) {
      // TUI prefill needs a separate chat-composer copy to remain visible after switching views.
      seedNativeChatLaunchDraftForAgentTab({
        tabId: activation.primaryTabId,
        agent: quickAgent,
        text: launchDraftPrompt
      })
    }
    if (
      !launchFailed &&
      !runtimeEnvironmentId &&
      !structuredLaunch &&
      startupPlan &&
      (startupPlan.followupPrompt || startupPlan.draftPrompt) &&
      activation !== false
    ) {
      void ensureAgentStartupInTerminal({
        worktreeId: folderWorkspaceKey(workspace.id),
        primaryTabId: activation.primaryTabId,
        startup: startupPlan
      })
    }
  } catch (error) {
    // Creation succeeded; a transient activation failure must not keep its completed modal open.
    console.error('Failed to activate folder workspace after create:', error)
  }
  return true
}
