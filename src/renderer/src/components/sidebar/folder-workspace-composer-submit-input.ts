import type { AgentLaunchChoice } from '@/lib/agent-menu-selection'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { AgentStartupSettings } from '../../../../shared/agent-startup-plan-inputs'
import type { AgentLaunchInputViews } from '../../../../shared/agent-launch-choices'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

type FolderWorkspaceCreateInput = {
  projectGroupId: string
  name: string
  connectionId?: string | null
  linkedTask: FolderWorkspace['linkedTask']
  linkedTaskSourceContext?: TaskSourceContext | null
  createdWithAgent?: TuiAgent
  pendingFirstAgentMessageRename?: boolean
}

export type SubmitFolderWorkspaceCreateParams = {
  projectGroup: ProjectGroup
  name: string
  lastAutoName: string
  linkedWorkItem: LinkedWorkItemSummary | null
  linkedTaskSourceContext?: TaskSourceContext | null
  note: string
  quickAgent: TuiAgent | null
  launchChoice?: AgentLaunchChoice
  launchInputs?: AgentLaunchInputViews
  sessionOptions?: Record<string, string>
  chatSessionOptions?: Readonly<Record<string, string>>
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
