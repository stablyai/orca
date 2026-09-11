import { ensureAgentStartupInTerminal, type LinkedWorkItemSummary } from '@/lib/new-workspace'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { preflightAgentTrust } from '@/lib/agent-trust-preflight'
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
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getLinkedItemDisplayName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { getNewWorkspaceProjectGroupHostId } from '@/lib/new-workspace-project-options'
import { useAppStore } from '@/store'
import {
  buildFolderWorkspaceLinkedStartupPlan,
  getFolderWorkspaceAgentLaunchPlatform,
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
  const plan = quickAgent
    ? planAgentSessionLaunch(useAppStore.getState(), {
        agent: quickAgent,
        workspace: {
          kind: 'folder',
          runtimeEnvironmentId,
          executionHostId: getNewWorkspaceProjectGroupHostId(projectGroup)
        },
        prompt: launchDraftPrompt ?? note,
        promptDelivery: launchDraftPrompt ? 'draft' : 'auto-submit',
        tuiCustomization: { agentArgs },
        initialSessionOptions: startupPlan?.sessionOptions
      })
    : null
  const structuredLaunch = plan?.route === 'structured-native-chat'
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
    ...(pendingFirstAgentMessageRename ? { pendingFirstAgentMessageRename: true } : {})
  })
  if (!workspace) {
    return false
  }
  if (!structuredLaunch) {
    await preflightAgentTrust({
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
      agent: quickAgent,
      ...(!structuredLaunch && startup ? { startup } : {}),
      ...(structuredLaunch ? { providesInitialSurface: true } : {}),
      runtimeEnvironmentId
    })
    let structuredLaunchAccepted = structuredLaunch
    const settlement =
      plan?.route === 'structured-native-chat'
        ? await plan.launch(
            {
              legacyFallback: async () => {
                if (pendingFirstAgentMessageRename) {
                  await useAppStore
                    .getState()
                    .updateFolderWorkspace(workspace.id, { pendingFirstAgentMessageRename: true })
                    .catch(() => undefined)
                }
                await preflightAgentTrust({
                  agent: quickAgent,
                  workspacePath: workspace.folderPath,
                  connectionId: workspace.connectionId ?? projectGroup.connectionId
                })
                const fallbackActivation = activateAndRevealFolderWorkspace(workspace.id, {
                  agent: quickAgent,
                  ...(startup ? { startup } : {}),
                  runtimeEnvironmentId
                })
                return {
                  activation: fallbackActivation,
                  primaryTabId:
                    fallbackActivation === false ? null : fallbackActivation.primaryTabId
                }
              }
            },
            { worktreeId: folderWorkspaceKey(workspace.id) }
          )
        : null
    if (settlement) {
      // Why: the workspace exists either way. Unknown keeps reporting false and failed true, as
      // the boolean did before the loop was shared; the launch layer owns the failure toast.
      if (settlement.kind === 'visibility-unknown') {
        return false
      }
      if (settlement.kind === 'failed' || settlement.kind === 'cancelled') {
        return true
      }
      if (settlement.kind === 'refused-then-legacy') {
        structuredLaunchAccepted = false
        // Why: this flow's own fallback always activates; `??` only satisfies the shared type.
        activation = settlement.activation ?? false
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
