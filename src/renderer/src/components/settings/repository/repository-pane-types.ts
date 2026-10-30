import type { Repo } from '../../../../../shared/repo-types'
import type { GhAccountBinding } from '../../../../../shared/github/account-binding'
import type { OrcaHooks } from '../../../../../shared/orca-yaml-hook-types'
import type { Project, ProjectUpdateArgs } from '../../../../../shared/project-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { SettingsProjectRemovalScope } from '../settings-project-list'
import type { RepositorySettingsSessionState } from './RepositorySettingsSession'

export type RepositoryPaneRepoUpdate = Omit<
  Partial<Repo>,
  'sourceControlAi' | 'externalWorktreeVisibility' | 'ghAccount'
> & {
  sourceControlAi?: Repo['sourceControlAi'] | null
  externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
  ghAccount?: GhAccountBinding | null
}

export type RepositoryPaneProps = {
  session?: RepositorySettingsSessionState
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  hooksInspectionReady: boolean
  mayNeedUpdate: boolean
  updateRepo: (
    repoId: string,
    updates: RepositoryPaneRepoUpdate,
    options?: { hostId?: ExecutionHostId }
  ) => void | Promise<boolean>
  removeProject: (repoId: string) => void
  project?: Project | null
  selectedProjectSetupId?: string
  settingsSelectionKey?: string
  settingsEntryRepoIds?: ReadonlySet<string>
  removalScope?: SettingsProjectRemovalScope
  isLocalWindowsProject?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
  updateProject?: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
}
