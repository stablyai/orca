import type { AgentLaunchChoice } from '@/lib/agent-session/launch/routing/agent-menu-selection'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import type { AgentStartupSettings } from '../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import type { AgentLaunchInputViews } from '../../../../../../shared/agent-launch/choices/agent-launch-choices'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { LaunchSource } from '../../../../../../shared/telemetry-events'
import type { TaskSourceContext } from '../../../../../../shared/work-items/task-source-context'

import type {
  FolderWorkspaceCreateInput,
  FolderWorkspaceCreateResult
} from '../../../../../../shared/folder-workspaces/folder-workspace-create'

export type SubmitFolderWorkspaceCreateParams = {
  setupSupported?: boolean
  setupApproval?: Pick<
    FolderWorkspaceCreateInput,
    'setupDecision' | 'approvedSetupHash' | 'approvedSetupHashes'
  >
  isCancelled?: () => boolean
  projectGroup: ProjectGroup
  name: string
  lastAutoName: string
  linkedWorkItem: LinkedWorkItemSummary | null
  linkedTaskSourceContext?: TaskSourceContext | null
  note: string
  quickAgent: TuiAgent | null
  launchChoice?: AgentLaunchChoice
  legacyLaunchInputs?: AgentLaunchInputViews
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
  createFolderWorkspace: (
    input: FolderWorkspaceCreateInput
  ) => Promise<FolderWorkspaceCreateResult | null>
  onOpenChange: (open: boolean) => void
}
