import {
  CLIENT_PLATFORM,
  buildAgentPromptWithContext,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { getLinkedWorkItemPromptContext } from '@/lib/linked-work-item-context'
import { isOrcaCliAvailableForLaunch } from '@/lib/orca-cli-launch-availability'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import { isWorkItemLookupText } from '@/lib/work-item-lookup-text'
import type { FolderWorkspace, ProjectGroup, TuiAgent } from '../../../../shared/types'
import {
  getLinkedItemDisplayName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'

type FolderWorkspaceCreateInput = {
  projectGroupId: string
  name: string
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
  createFolderWorkspace: (input: FolderWorkspaceCreateInput) => Promise<FolderWorkspace | null>
  onOpenChange: (open: boolean) => void
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
  createFolderWorkspace,
  onOpenChange
}: SubmitFolderWorkspaceCreateParams): Promise<void> {
  const linkedName = linkedWorkItem ? getLinkedItemDisplayName(linkedWorkItem) : null
  const nameIsAutoManaged = !name.trim() || name === lastAutoName || isWorkItemLookupText(name)
  const workspaceName =
    nameIsAutoManaged && linkedName
      ? linkedName
      : name.trim() || linkedName || `${projectGroup.name} workspace`
  const pendingFirstAgentMessageRename =
    autoRenameBranchFromWork === true && !name.trim() && !linkedWorkItem && Boolean(quickAgent)

  const workspace = await createFolderWorkspace({
    projectGroupId: projectGroup.id,
    name: workspaceName,
    linkedTask: toFolderWorkspaceLinkedTask(linkedWorkItem),
    ...(quickAgent ? { createdWithAgent: quickAgent } : {}),
    ...(pendingFirstAgentMessageRename ? { pendingFirstAgentMessageRename: true } : {})
  })
  if (!workspace) {
    return
  }

  const linearCliAvailable = linkedWorkItem?.linearIdentifier
    ? await isOrcaCliAvailableForLaunch({ remote: projectGroup.connectionId != null })
    : false
  const linkedPromptContext = getLinkedWorkItemPromptContext(linkedWorkItem, {
    cliAvailable: linearCliAvailable
  })
  const startupPrompt = buildAgentPromptWithContext(
    note,
    [],
    linkedPromptContext.linkedUrls,
    linkedPromptContext.linkedContextBlocks
  )
  const startupPlan = quickAgent
    ? buildAgentStartupPlan({
        agent: quickAgent,
        prompt: startupPrompt,
        cmdOverrides: agentCmdOverrides ?? {},
        platform: CLIENT_PLATFORM,
        allowEmptyPromptLaunch: true
      })
    : null
  const startup =
    quickAgent && startupPlan
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          telemetry: {
            agent_kind: tuiAgentToAgentKind(quickAgent),
            launch_source: 'sidebar' as const,
            request_kind: 'new' as const
          }
        }
      : undefined
  onOpenChange(false)
  try {
    activateAndRevealFolderWorkspace(workspace.id, startup ? { startup } : undefined)
  } catch (error) {
    // Why: creation already succeeded. Do not leave the completed create modal
    // open if the follow-up reveal/startup path hits a transient issue.
    console.error('Failed to activate folder workspace after create:', error)
  }
}
