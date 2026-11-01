import { ensureAgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from '../../../../shared/agent-startup-plan-inputs'
import { ensureAgentStartupInTerminal, type LinkedWorkItemSummary } from '@/lib/new-workspace'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import { shouldApplyWorkspaceSourceAutoName } from '../../../../shared/new-workspace/workspace-source'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getLinkedItemDisplayName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'
import {
  planAgentSessionLaunch,
  adoptAgentSessionLaunchVerdict
} from '@/lib/agent-session-launch-plan'
import type { AgentLaunchChoice } from '@/lib/agent-menu-selection'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { getNewWorkspaceProjectGroupHostId } from '@/lib/new-workspace-project-options'
import { useAppStore } from '@/store'
import { resolveExecutionHostAgentStartupShell } from '@/lib/execution-host-facts'
import {
  buildFolderWorkspaceLinkedStartupPlan,
  getFolderWorkspaceAgentLaunchFact,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-agent-startup'

export {
  buildFolderWorkspaceLinkedStartupPlan,
  getFolderWorkspaceAgentLaunchFact,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-agent-startup'
import { translate } from '@/i18n/i18n'

type FolderWorkspaceCreateInput = {
  projectGroupId: string
  name: string
  connectionId?: string | null
  linkedTask: FolderWorkspace['linkedTask']
  linkedTaskSourceContext?: TaskSourceContext | null
  createdWithAgent?: TuiAgent
  pendingFirstAgentMessageRename?: boolean
}

type SubmitFolderWorkspaceCreateParams = {
  projectGroup: ProjectGroup
  name: string
  lastAutoName: string
  linkedWorkItem: LinkedWorkItemSummary | null
  linkedTaskSourceContext?: TaskSourceContext | null
  note: string
  quickAgent: TuiAgent | null
  launchChoice?: AgentLaunchChoice
  autoRenameBranchFromWork: boolean | undefined
  settings?: AgentStartupSettings
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  terminalWindowsShell?: string | null
  isRemote?: boolean
  launchSource?: LaunchSource
  runtimeEnvironmentId?: string | null
  createFolderWorkspace: (input: FolderWorkspaceCreateInput) => Promise<FolderWorkspace | null>
  onOpenChange: (open: boolean) => void
}

export async function submitFolderWorkspaceCreate({
  projectGroup,
  name,
  lastAutoName,
  linkedWorkItem,
  linkedTaskSourceContext,
  note,
  quickAgent,
  launchChoice,
  autoRenameBranchFromWork,
  settings,
  agentCmdOverrides,
  agentArgs,
  agentEnv,
  terminalWindowsShell,
  launchSource = 'sidebar',
  runtimeEnvironmentId = null,
  createFolderWorkspace,
  onOpenChange
}: SubmitFolderWorkspaceCreateParams): Promise<boolean> {
  const linkedName = linkedWorkItem ? getLinkedItemDisplayName(linkedWorkItem) : null
  const nameIsAutoManaged = shouldApplyWorkspaceSourceAutoName({
    currentName: name,
    lastAutoName,
    lookupTextIsQuery: !linkedWorkItem
  })
  const workspaceName =
    nameIsAutoManaged && linkedName
      ? linkedName
      : name.trim() ||
        linkedName ||
        translate(
          'auto.components.sidebar.folderWorkspaceComposer.defaultWorkspaceName',
          '{{name}} workspace',
          { name: projectGroup.name }
        )
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
          executionHostId: getNewWorkspaceProjectGroupHostId(projectGroup)
        })
      : undefined
  const effectiveSettings = settings
    ? {
        ...settings,
        agentLaunchChoices: preferences?.agentLaunchChoices ?? settings.agentLaunchChoices
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
        requestId: newAgentLaunchRequestId(),
        agent: quickAgent,
        workspace: {
          kind: 'folder' as const,
          runtimeEnvironmentId,
          executionHostId: getNewWorkspaceProjectGroupHostId(projectGroup)
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
  // Show pending rename only when the submitted prompt can produce a naming message.
  const pendingFirstAgentMessageRename =
    autoRenameBranchFromWork === true &&
    !name.trim() &&
    !linkedWorkItem &&
    Boolean(quickAgent) &&
    note.trim().length > 0

  const workspace = await createFolderWorkspace({
    projectGroupId: projectGroup.id,
    name: workspaceName,
    // Retain the SSH target even when another host owns the focused runtime.
    connectionId: projectGroup.connectionId ?? null,
    linkedTask: toFolderWorkspaceLinkedTask(linkedWorkItem),
    ...(linkedTaskSourceContext ? { linkedTaskSourceContext } : {}),
    ...(quickAgent ? { createdWithAgent: quickAgent } : {}),
    ...(pendingFirstAgentMessageRename ? { pendingFirstAgentMessageRename: true } : {})
  })
  if (!workspace) {
    return false
  }
  if (startupPlan && !startupPlan.launchToken) {
    // Share one token so delayed startup delivery reaches exactly the pane it spawned.
    startupPlan.launchToken = createBrowserUuid()
  }

  const startup =
    quickAgent && startupPlan
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(startupPlan.launchToken ? { launchToken: startupPlan.launchToken } : {}),
          launchAgent: quickAgent,
          ...(startupPlan.draftPrompt ? { draftPrompt: startupPlan.draftPrompt } : {}),
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          telemetry: {
            agent_kind: tuiAgentToAgentKind(quickAgent),
            launch_source: launchSource,
            request_kind: 'new' as const
          }
        }
      : undefined
  onOpenChange(false)
  try {
    const activationHolder: {
      value: ReturnType<typeof activateAndRevealFolderWorkspace>
    } = { value: false }
    const revealWorkspace = (): boolean => {
      activationHolder.value = activateAndRevealFolderWorkspace(workspace.id, {
        agent: quickAgent,
        ...(!structuredLaunch && startup ? { startup } : {}),
        ...(structuredLaunch ? { providesInitialSurface: true } : {}),
        runtimeEnvironmentId
      })
      return activationHolder.value !== false
    }
    const structuredLaunchAccepted = structuredLaunch
    if (plan?.route === 'structured-native-chat') {
      beginStructuredAgentSessionProvisionalLaunch({
        plan,
        hooks: {},
        target: { worktreeId: folderWorkspaceKey(workspace.id) },
        beforeOpen: revealWorkspace
      })
    } else {
      revealWorkspace()
    }
    const activation = activationHolder.value
    if (
      !structuredLaunchAccepted &&
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
      !structuredLaunchAccepted &&
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
