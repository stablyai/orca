import {
  CLIENT_PLATFORM,
  ensureAgentStartupInTerminal,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import { isWorkItemLookupText } from '@/lib/work-item-lookup-text'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getLinkedItemDisplayName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'
import {
  hasExplicitTuiLaunchCustomization,
  hasExplicitTuiAgentArgs,
  resolveAgentLaunchRoute
} from '@/lib/agent-launch-routing'
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { startStructuredCodexLaunch } from '@/lib/structured-agent-session-launch'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import { useAppStore } from '@/store'
import {
  buildFolderWorkspaceLinkedStartupPlan,
  getFolderWorkspaceAgentLaunchPlatform,
  preflightFolderWorkspaceAgentTrust,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-agent-startup'

export {
  buildFolderWorkspaceLinkedStartupPlan,
  getFolderWorkspaceAgentLaunchPlatform,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-agent-startup'

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
  autoRenameBranchFromWork: boolean | undefined
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  sessionOptions?: Record<string, SessionOptionValue>
  terminalWindowsShell?: string | null
  isRemote?: boolean
  launchSource?: LaunchSource
  runtimeEnvironmentId?: string | null
  settings?: GlobalSettings | null
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
  autoRenameBranchFromWork,
  agentCmdOverrides,
  agentArgs,
  agentEnv,
  sessionOptions,
  terminalWindowsShell,
  launchSource = 'sidebar',
  runtimeEnvironmentId = null,
  settings,
  createFolderWorkspace,
  onOpenChange
}: SubmitFolderWorkspaceCreateParams): Promise<boolean> {
  const linkedName = linkedWorkItem ? getLinkedItemDisplayName(linkedWorkItem) : null
  const nameIsAutoManaged = !name.trim() || name === lastAutoName || isWorkItemLookupText(name)
  const workspaceName =
    nameIsAutoManaged && linkedName
      ? linkedName
      : name.trim() || linkedName || `${projectGroup.name} workspace`
  const launchPlatform = getFolderWorkspaceAgentLaunchPlatform(projectGroup)
  // Why: an SSH folder group runs the plain `orca` relay shim, so the Linux-only
  // `orca-ide` rename must not be applied for remote launches.
  const launchIsRemote = Boolean(projectGroup.connectionId)
  const launchShell = resolveLocalWindowsAgentStartupShell({
    platform: launchPlatform,
    isRemote: launchIsRemote,
    terminalWindowsShell
  })
  const startupPlan =
    quickAgent && linkedWorkItem
      ? buildFolderWorkspaceLinkedStartupPlan({
          agent: quickAgent,
          linkedWorkItem,
          note,
          agentCmdOverrides,
          agentArgs,
          agentEnv,
          sessionOptions,
          platform: launchPlatform,
          shell: launchShell,
          isRemote: launchIsRemote
        })
      : quickAgent
        ? buildAgentStartupPlan({
            agent: quickAgent,
            prompt: note,
            cmdOverrides: agentCmdOverrides ?? {},
            agentArgs,
            agentEnv,
            sessionOptions,
            platform: launchPlatform,
            shell: launchShell,
            isRemote: launchIsRemote,
            allowEmptyPromptLaunch: true
          })
        : null
  // Why: the argv-prefill plan carries the draft inside `launchCommand`, so
  // `startupPlan.draftPrompt` alone can't tell whether this launch has one.
  const launchDraftPrompt =
    quickAgent && linkedWorkItem ? resolveFolderWorkspaceLaunchDraft(linkedWorkItem, note) : null
  const agentLaunchRoute = quickAgent
    ? resolveAgentLaunchRoute({
        agent: quickAgent,
        settings,
        executionHostId: runtimeEnvironmentId
          ? `runtime:${encodeURIComponent(runtimeEnvironmentId)}`
          : (projectGroup.connectionId ?? 'local'),
        platform: CLIENT_PLATFORM,
        hostCapabilities: readLocalRuntimeCapabilities(),
        workspaceKind: 'folder',
        promptDelivery: launchDraftPrompt ? 'draft' : 'auto-submit',
        launchText: launchDraftPrompt ?? note,
        nativeChatTranscriptIsLocalReadable: !launchIsRemote,
        requiresTuiLaunchCustomization:
          hasExplicitTuiAgentArgs(quickAgent, agentArgs) ||
          hasExplicitTuiLaunchCustomization(settings, quickAgent),
        initialSessionOptions: startupPlan?.sessionOptions
      })
    : 'terminal-tui'
  const structuredLaunch = agentLaunchRoute === 'structured-native-chat'
  // Why: the pending badge should only appear when the submitted prompt can
  // actually produce the first agent message that names the workspace.
  const pendingFirstAgentMessageRename =
    autoRenameBranchFromWork === true &&
    !name.trim() &&
    !linkedWorkItem &&
    Boolean(quickAgent) &&
    note.trim().length > 0

  const workspace = await createFolderWorkspace({
    projectGroupId: projectGroup.id,
    name: workspaceName,
    // Why: SSH folder groups must keep their target provenance even when the
    // focused runtime is local or another host.
    connectionId: projectGroup.connectionId ?? null,
    linkedTask: toFolderWorkspaceLinkedTask(linkedWorkItem),
    ...(linkedTaskSourceContext ? { linkedTaskSourceContext } : {}),
    ...(quickAgent ? { createdWithAgent: quickAgent } : {}),
    ...(pendingFirstAgentMessageRename && !structuredLaunch
      ? { pendingFirstAgentMessageRename: true }
      : {})
  })
  if (!workspace) {
    return false
  }
  if (!structuredLaunch) {
    await preflightFolderWorkspaceAgentTrust({
      agent: quickAgent,
      workspacePath: workspace.folderPath,
      connectionId: workspace.connectionId ?? projectGroup.connectionId
    })
  }
  if (startupPlan && !startupPlan.launchToken) {
    // Why: delayed delivery must target the exact pane spawned from this queued
    // startup, so both halves share one renderer-session token.
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
          ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
          ...(startupPlan.draftPrompt ? { draftPrompt: startupPlan.draftPrompt } : {}),
          // Why: view-mode only. The argv-prefill plan sets no draftPrompt, so
          // without this the tab opens in chat with nothing mirrored into it.
          ...(launchDraftPrompt ? { launchDraftText: launchDraftPrompt } : {}),
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
    let activation = activateAndRevealFolderWorkspace(workspace.id, {
      ...(!structuredLaunch && startup ? { startup } : {}),
      ...(structuredLaunch ? { providesInitialSurface: true } : {}),
      runtimeEnvironmentId
    })
    let structuredLaunchAccepted = structuredLaunch
    if (structuredLaunch && quickAgent === 'codex') {
      const launch = startStructuredCodexLaunch(folderWorkspaceKey(workspace.id), {
        prompt: launchDraftPrompt ?? note
      })
      const refusalFallback = launch.claimDefinitiveRefusalFallback(async () => {
        structuredLaunchAccepted = false
        if (pendingFirstAgentMessageRename) {
          await useAppStore
            .getState()
            .updateFolderWorkspace(workspace.id, { pendingFirstAgentMessageRename: true })
            .catch(() => undefined)
        }
        await preflightFolderWorkspaceAgentTrust({
          agent: quickAgent,
          workspacePath: workspace.folderPath,
          connectionId: workspace.connectionId ?? projectGroup.connectionId
        })
        activation = activateAndRevealFolderWorkspace(workspace.id, {
          ...(startup ? { startup } : {}),
          runtimeEnvironmentId
        })
      })
      try {
        await launch.launchResult
      } catch (error) {
        if (!(error instanceof StructuredAgentSessionCreateRefusalError)) {
          return !launch.isVisibilityUnknown()
        }
        await refusalFallback
      }
    }
    if (
      !structuredLaunchAccepted &&
      quickAgent &&
      startupPlan &&
      launchDraftPrompt &&
      activation !== false &&
      activation.primaryTabId
    ) {
      // Why: draft launch context reaches only the TUI input; seed the
      // chat-composer copy so it isn't invisible in the chat view.
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
    // Why: creation already succeeded. Do not leave the completed create modal
    // open if the follow-up reveal/startup path hits a transient issue.
    console.error('Failed to activate folder workspace after create:', error)
  }
  return true
}
