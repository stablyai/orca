import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Project, ProjectUpdateArgs } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { SettingsSearchEntry } from './settings-search'
import type { ProjectRuntimeSessionSummary } from './repository-runtime-session-summary'
import type { RepositoryPaneRepoUpdate } from './RepositoryPane'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'
import { RepositoryWindowsRuntimeSection } from './RepositoryWindowsRuntimeSection'
import { RepositoryForkSyncSection } from './RepositoryForkSyncSection'
import { RepositoryGitHubAccountSection } from './RepositoryGitHubAccountSection'
import { RepositoryClaudeAccountSection } from './RepositoryClaudeAccountSection'
import { RepositoryWorktreeDefaultsSection } from './RepositoryWorktreeDefaultsSection'

type RepositoryProjectSettingsSectionsProps = {
  repo: Repo
  selectedProjectSetupId?: string
  forceVisible: boolean
  searchQuery: string
  hostSetupEntries: SettingsSearchEntry[]
  project: Project | null
  settings: GlobalSettings | null
  repoOwnerSettings: GlobalSettings | null
  isLocalWindowsProject: boolean
  wslAvailable: boolean
  wslDistros: string[]
  wslCapabilitiesLoading: boolean
  runtimeSessionSummary?: ProjectRuntimeSessionSummary
  updateProject?: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
  projectRuntimeEntries: SettingsSearchEntry[]
  updateSelectedRepo: (repoId: string, updates: RepositoryPaneRepoUpdate) => void | Promise<boolean>
  refreshWorktrees: (repoId: string) => void | Promise<unknown>
}

/** The project-scoped settings sections shown for non-folder repos, below Identity. */
export function RepositoryProjectSettingsSections({
  repo,
  selectedProjectSetupId,
  forceVisible,
  searchQuery,
  hostSetupEntries,
  project,
  settings,
  repoOwnerSettings,
  isLocalWindowsProject,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading,
  runtimeSessionSummary,
  updateProject,
  projectRuntimeEntries,
  updateSelectedRepo,
  refreshWorktrees
}: RepositoryProjectSettingsSectionsProps): React.JSX.Element {
  return (
    <>
      <RepositoryHostSetupsSection
        repo={repo}
        selectedProjectSetupId={selectedProjectSetupId}
        forceVisible={forceVisible}
        searchQuery={searchQuery}
        searchEntries={hostSetupEntries}
      />

      <RepositoryWindowsRuntimeSection
        repoDisplayName={repo.displayName}
        project={project}
        settings={settings}
        isLocalWindowsProject={isLocalWindowsProject}
        wslAvailable={wslAvailable}
        wslDistros={wslDistros}
        wslCapabilitiesLoading={wslCapabilitiesLoading}
        runtimeSessionSummary={runtimeSessionSummary}
        updateProject={updateProject}
        forceVisible={forceVisible}
        searchQuery={searchQuery}
        searchEntries={projectRuntimeEntries}
      />

      <RepositoryForkSyncSection
        repo={repo}
        updateRepo={updateSelectedRepo}
        forceVisible={forceVisible}
      />

      <RepositoryGitHubAccountSection
        repo={repo}
        updateRepo={updateSelectedRepo}
        forceVisible={forceVisible}
      />

      <RepositoryClaudeAccountSection
        repo={repo}
        updateRepo={updateSelectedRepo}
        forceVisible={forceVisible}
      />

      <RepositoryWorktreeDefaultsSection
        repo={repo}
        settings={repoOwnerSettings}
        updateRepo={updateSelectedRepo}
        refreshRepo={refreshWorktrees}
        forceVisible={forceVisible}
      />
    </>
  )
}
