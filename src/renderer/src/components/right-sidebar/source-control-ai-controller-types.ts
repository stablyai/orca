import type { AppState } from '@/store'
import type {
  GitConflictOperation,
  GitStatusEntry,
  GlobalSettings,
  Repo
} from '../../../../shared/types'

export type SourceControlAiStoreSnapshot = Pick<
  AppState,
  'settings' | 'repos' | 'ensureDetectedAgents' | 'ensureRemoteDetectedAgents'
>

export type SourceControlAiControllerParams = {
  settings: GlobalSettings | null
  activeRepo: Repo | null
  activeWorktreeId: string | null | undefined
  activeConnectionId: string | null | undefined
  activeGroupId: string | null | undefined
  activeSourceControlLaunchPlatform: NodeJS.Platform
  conflictOperation: GitConflictOperation
  unresolvedConflicts: Pick<GitStatusEntry, 'path' | 'conflictKind'>[]
  stagedEntries: Pick<GitStatusEntry, 'path' | 'status' | 'area'>[]
  worktreePath: string | null
  commitMessage: string
  commitError: string | null
  updateSettings: AppState['updateSettings']
  updateRepo: AppState['updateRepo']
  openSettingsTarget: AppState['openSettingsTarget']
  openSettingsPage: AppState['openSettingsPage']
  getStoreState?: () => SourceControlAiStoreSnapshot
}
