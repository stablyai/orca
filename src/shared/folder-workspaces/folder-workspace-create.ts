import type { FolderWorkspace } from './folder-workspace-types'
import type { CreateWorktreeArgs, CreateWorktreeResult } from '../worktree/create-types'
import type { WorktreeStartupLaunch } from '../worktree/creation/launch-types'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { AgentLaunchPreferences } from '../agent-session/agent-session-host-authority'

export type FolderWorkspaceCreateInput = {
  projectGroupId: string
  name?: string
  folderPath?: string | null
  connectionId?: string | null
  linkedTask?: FolderWorkspace['linkedTask']
  linkedItems?: FolderWorkspace['linkedItems']
  linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
  createdWithAgent?: TuiAgent
  pendingFirstAgentMessageRename?: boolean
  agentLaunchMode?: 'structured'
  startupCommand?: string
  startupEnv?: Record<string, string>
  startupLaunchConfig?: WorktreeStartupLaunch['launchConfig']
  startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
  startupAgent?: TuiAgent
  startupPrompt?: string
  startupDraft?: string
  startupAgentArgs?: string | null
  startupSessionOptions?: Record<string, string>
  startupLaunchPreferences?: AgentLaunchPreferences
  launchSource?: string
} & Pick<CreateWorktreeArgs, 'setupDecision' | 'approvedSetupHash' | 'approvedSetupHashes'>

export type FolderWorkspaceCreateResult = {
  folderWorkspace: FolderWorkspace
} & Pick<
  CreateWorktreeResult,
  'setup' | 'setupReceipt' | 'startupTerminal' | 'warning' | 'setupTrustMismatch'
>
