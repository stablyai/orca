import type { FolderWorkspace } from './folder-workspace-types'
import type { CreateWorktreeArgs, CreateWorktreeResult } from '../worktree/create-types'
import type { WorktreeStartupLaunch } from '../worktree/launch-types'
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
  startupPromptDelivery?: 'draft' | 'auto-submit'
  startupAgentArgs?: string | null
  startupSessionOptions?: Record<string, string>
  startupLaunchPreferences?: AgentLaunchPreferences
  launchSource?: string
} & Pick<CreateWorktreeArgs, 'setupDecision' | 'approvedSetupHash' | 'approvedSetupHashes'>

export type FolderWorkspaceAgentLaunchOutcome =
  | { status: 'not-required' | 'successful' }
  | {
      status: 'failed'
      reason: 'preparation' | 'spawn' | 'observation' | 'exit' | 'timeout' | 'cancelled'
    }

export type FolderWorkspaceCreateResult = {
  folderWorkspace: FolderWorkspace
  agentLaunchOutcome?: FolderWorkspaceAgentLaunchOutcome
} & Pick<
  CreateWorktreeResult,
  'setup' | 'setupReceipt' | 'startupTerminal' | 'warning' | 'setupTrustMismatch'
>
