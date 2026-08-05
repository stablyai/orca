import {
  CLIENT_PLATFORM,
  ensureAgentStartupInTerminal,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import { isWorkItemLookupText } from '@/lib/work-item-lookup-text'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { FolderWorkspace, ProjectGroup, TuiAgent } from '../../../../shared/types'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { normalizeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { resolveCursorCommandOverrides } from '@/lib/ai-vault-cursor-command'
import {
  getLinkedItemDisplayName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'

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

export function getFolderWorkspaceAgentLaunchPlatform(
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'parentPath'>
): NodeJS.Platform {
  const parentPath = projectGroup.parentPath?.trim() ?? ''
  if (projectGroup.connectionId) {
    return isWindowsAbsolutePathLike(parentPath) ? 'win32' : 'linux'
  }
  return parentPath && isWslUncPath(parentPath) ? 'linux' : CLIENT_PLATFORM
}

/**
 * The launch context a linked folder-workspace agent starts with in its TUI
 * input but never submits — delivered as argv prefill or a startup paste
 * depending on the agent.
 */
export function resolveFolderWorkspaceLaunchDraft(
  linkedWorkItem: LinkedWorkItemSummary,
  note: string
): string | null {
  const { prompt, draftPrompt } = resolveQuickCreateLinkedWorkItemPrompt(linkedWorkItem, note)
  return (draftPrompt ?? prompt.trim()) || null
}

export function buildFolderWorkspaceLinkedStartupPlan(args: {
  agent: TuiAgent
  linkedWorkItem: LinkedWorkItemSummary
  note: string
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  sessionOptions?: Record<string, SessionOptionValue>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote: boolean
}): AgentStartupPlan | null {
  const linkedDraftPrompt = resolveFolderWorkspaceLaunchDraft(args.linkedWorkItem, args.note)
  const draftLaunchPlan = linkedDraftPrompt
    ? buildAgentDraftLaunchPlan({
        agent: args.agent,
        draft: linkedDraftPrompt,
        cmdOverrides: args.agentCmdOverrides ?? {},
        agentArgs: args.agentArgs,
        agentEnv: args.agentEnv,
        sessionOptions: args.sessionOptions,
        platform: args.platform,
        shell: args.shell,
        isRemote: args.isRemote
      })
    : null
  if (draftLaunchPlan) {
    return {
      agent: draftLaunchPlan.agent,
      launchCommand: draftLaunchPlan.launchCommand,
      expectedProcess: draftLaunchPlan.expectedProcess,
      followupPrompt: null,
      launchConfig: draftLaunchPlan.launchConfig,
      ...(draftLaunchPlan.sessionOptions ? { sessionOptions: draftLaunchPlan.sessionOptions } : {}),
      ...(draftLaunchPlan.startupCommandDelivery
        ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
        : {}),
      ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
    }
  }

  const startupPlan = buildAgentStartupPlan({
    agent: args.agent,
    // Why: linked context must stay reviewable; launch empty, then paste the
    // draft after the agent is ready instead of submitting it on argv/stdin.
    prompt: '',
    cmdOverrides: args.agentCmdOverrides ?? {},
    agentArgs: args.agentArgs,
    agentEnv: args.agentEnv,
    sessionOptions: args.sessionOptions,
    platform: args.platform,
    shell: args.shell,
    isRemote: args.isRemote,
    allowEmptyPromptLaunch: true
  })
  if (startupPlan && linkedDraftPrompt) {
    startupPlan.draftPrompt = linkedDraftPrompt
  }
  return startupPlan
}

async function preflightFolderWorkspaceAgentTrust(args: {
  agent: TuiAgent | null
  workspacePath: string | null
  connectionId?: string | null
}): Promise<void> {
  if (!args.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  const preflight = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preflight || !args.workspacePath) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best-effort: the user can still accept the agent trust prompt manually.
  }
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
  const effectiveCmdOverrides = quickAgent
    ? resolveCursorCommandOverrides({
        state: useAppStore.getState(),
        agent: quickAgent,
        cmdOverrides: agentCmdOverrides ?? {},
        executionHostId: projectGroup.connectionId
          ? toSshExecutionHostId(projectGroup.connectionId)
          : normalizeExecutionHostId(projectGroup.executionHostId),
        workspacePath: projectGroup.parentPath
      })
    : agentCmdOverrides
  const startupPlan =
    quickAgent && linkedWorkItem
      ? buildFolderWorkspaceLinkedStartupPlan({
          agent: quickAgent,
          linkedWorkItem,
          note,
          agentCmdOverrides: effectiveCmdOverrides,
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
            cmdOverrides: effectiveCmdOverrides ?? {},
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
  await preflightFolderWorkspaceAgentTrust({
    agent: quickAgent,
    workspacePath: workspace.folderPath,
    connectionId: workspace.connectionId ?? projectGroup.connectionId
  })
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
    const activation = activateAndRevealFolderWorkspace(workspace.id, {
      ...(startup ? { startup } : {}),
      runtimeEnvironmentId
    })
    if (
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
