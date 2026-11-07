import type { AppState } from '@/store'
import type { WorktreeAgentInventoryState } from '@/lib/agent-detection-target-inventory'
import type {
  GitConflictOperation,
  GitStatusEntry
} from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlRenderSettings } from '../listing/use-worktree-context'
import type { Repo } from '../../../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

export type SourceControlAiStoreSnapshot = Pick<AppState, 'settings' | 'repos'> &
  Omit<WorktreeAgentInventoryState, 'repos'>

export type SourceControlAiControllerParams = {
  settings: SourceControlRenderSettings | null
  /** The repo owner's transport; it scopes model discovery. */
  target: RuntimeClientTarget | null
  activeRepo: Repo | null
  activeWorktreeId: string | null | undefined
  activeConnectionId: string | null | undefined
  activeGroupId: string | null | undefined
  activeSourceControlLaunchPlatform: NodeJS.Platform | undefined
  conflictOperation: GitConflictOperation
  unresolvedConflicts: Pick<GitStatusEntry, 'path' | 'conflictKind'>[]
  stagedEntries: Pick<GitStatusEntry, 'path' | 'status' | 'area'>[]
  worktreePath: string | null
  commitMessage: string
  commitError: string | null
  pushRecoveryPrompt: string | null
  updateSettings: AppState['updateSettings']
  updateSettingsOrThrow: AppState['updateSettingsOrThrow']
  updateRepo: AppState['updateRepo']
  openSettingsTarget: AppState['openSettingsTarget']
  openSettingsPage: AppState['openSettingsPage']
  getStoreState?: () => SourceControlAiStoreSnapshot
}
