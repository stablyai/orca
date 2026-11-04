import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { GhAccountBinding } from '../../../../../shared/github/account-binding'
import type { OrcaHooks } from '../../../../../shared/orca-yaml-hook-types'
import type {
  Project,
  ProjectHostSetup,
  ProjectUpdateArgs
} from '../../../../../shared/project-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { SettingsProjectRemovalScope } from '../navigation/settings-project-list'
import type { SettingsProjectRemoval } from './RepositoryRemoveProjectButton'
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
  writeSourceControlAiSettings?: (patch: SourceControlAiSettingsPatch) => Promise<void>
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
  removeProject: (repoId: string, accepted?: SettingsProjectRemoval) => void
  project?: Project | null
  selectedProjectSetupId?: string
  settingsSelectionKey?: string
  settingsEntryRepoIds?: ReadonlySet<string>
  removalSetups?: readonly ProjectHostSetup[]
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
