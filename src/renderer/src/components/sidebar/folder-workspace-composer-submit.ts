import {
  CLIENT_PLATFORM,
  ensureAgentStartupInTerminal,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import { isOrcaCliAvailableForLaunch } from '@/lib/orca-cli-launch-availability'
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
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getLinkedItemDisplayName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'

type FolderWorkspaceCreateInput = {
  projectGroupId: string
  name: string
  connectionId?: string | null
  linkedTask: FolderWorkspace['linkedTask']
  createdWithAgent?: TuiAgent
  pendingFirstAgentMessageRename?: boolean
}

type SubmitFolderWorkspaceCreateParams = {
  projectGroup: ProjectGroup
  name: string
  lastAutoName: string
  linkedWorkItem: LinkedWorkItemSummary | null
  note: string
  quickAgent: TuiAgent | null
  autoRenameBranchFromWork: boolean | undefined
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
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

function buildFolderWorkspaceLinkedStartupPlan(args: {
  agent: TuiAgent
  linkedWorkItem: LinkedWorkItemSummary
  note: string
  cliAvailable: boolean
  agentCmdOverrides: Record<string, string> | undefined
  agentArgs?: string | null
  agentEnv?: Record<string, string>
  platform: NodeJS.Platform
}): AgentStartupPlan | null {
  const { prompt, draftPrompt } = resolveQuickCreateLinkedWorkItemPrompt(
    args.linkedWorkItem,
    args.note,
    {
      cliAvailable: args.cliAvailable
    }
  )
  const linkedDraftPrompt = (draftPrompt ?? prompt.trim()) || null
  const draftLaunchPlan = linkedDraftPrompt
    ? buildAgentDraftLaunchPlan({
        agent: args.agent,
        draft: linkedDraftPrompt,
        cmdOverrides: args.agentCmdOverrides ?? {},
        agentArgs: args.agentArgs,
        agentEnv: args.agentEnv,
        platform: args.platform
      })
    : null
  if (draftLaunchPlan) {
    return {
      agent: draftLaunchPlan.agent,
      launchCommand: draftLaunchPlan.launchCommand,
      expectedProcess: draftLaunchPlan.expectedProcess,
      followupPrompt: null,
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
    platform: args.platform,
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
  note,
  quickAgent,
  autoRenameBranchFromWork,
  agentCmdOverrides,
  agentArgs,
  agentEnv,
  isRemote,
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
  // Why: only suggest `orca linear` when the launched terminal can actually
  // resolve the CLI; SSH launches get the relay shim, local launches may not.
  const linearCliAvailable =
    quickAgent && linkedWorkItem?.linearIdentifier
      ? await isOrcaCliAvailableForLaunch({ remote: isRemote ?? projectGroup.connectionId != null })
      : false
  const startupPlan =
    quickAgent && linkedWorkItem
      ? buildFolderWorkspaceLinkedStartupPlan({
          agent: quickAgent,
          linkedWorkItem,
          note,
          cliAvailable: linearCliAvailable,
          agentCmdOverrides,
          agentArgs,
          agentEnv,
          platform: launchPlatform
        })
      : quickAgent
        ? buildAgentStartupPlan({
            agent: quickAgent,
            prompt: note,
            cmdOverrides: agentCmdOverrides ?? {},
            agentArgs,
            agentEnv,
            platform: launchPlatform,
            allowEmptyPromptLaunch: true
          })
        : null
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

  const startup =
    quickAgent && startupPlan
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
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
