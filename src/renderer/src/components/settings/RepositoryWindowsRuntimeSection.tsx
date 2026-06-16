import type { GlobalSettings, Project, ProjectUpdateArgs } from '../../../../shared/types'
import { SearchableSetting } from './SearchableSetting'
import type { SettingsSearchEntry } from './settings-search'
import { matchesSettingsSearch } from './settings-search'
import { ProjectWindowsRuntimeSetting } from './ProjectWindowsRuntimeSetting'
import type { ProjectRuntimeSessionSummary } from './repository-runtime-session-summary'
import { translate } from '@/i18n/i18n'

type RepositoryWindowsRuntimeSectionProps = {
  repoDisplayName: string
  project: Project | null
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'> | null
  isLocalWindowsProject: boolean
  wslAvailable: boolean
  wslDistros: string[]
  wslCapabilitiesLoading: boolean
  runtimeSessionSummary?: ProjectRuntimeSessionSummary
  updateProject?: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
  forceVisible: boolean
  searchQuery: string
  searchEntries: SettingsSearchEntry[]
}

export function RepositoryWindowsRuntimeSection({
  repoDisplayName,
  project,
  settings,
  isLocalWindowsProject,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading,
  runtimeSessionSummary,
  updateProject,
  forceVisible,
  searchQuery,
  searchEntries
}: RepositoryWindowsRuntimeSectionProps): React.JSX.Element | null {
  if (!settings || !project || !updateProject || !isLocalWindowsProject) {
    return null
  }

  return (
    <SearchableSetting
      title={translate('auto.components.settings.RepositoryPane.projectRuntime', 'Project Runtime')}
      description={translate(
        'auto.components.settings.RepositoryPane.projectRuntimeDescription',
        'Choose whether this project runs on Windows or WSL.'
      )}
      keywords={[
        repoDisplayName,
        'runtime',
        'execution',
        'windows host',
        'wsl',
        'distro',
        'agent runtime',
        'skill runtime'
      ]}
      className="space-y-3"
      forceVisible={forceVisible || matchesSettingsSearch(searchQuery, searchEntries)}
    >
      <ProjectWindowsRuntimeSetting
        project={project}
        settings={settings}
        isLocalWindowsProject={isLocalWindowsProject}
        wslAvailable={wslAvailable}
        wslDistros={wslDistros}
        wslCapabilitiesLoading={wslCapabilitiesLoading}
        runtimeSessionSummary={runtimeSessionSummary}
        updateProject={updateProject}
      />
    </SearchableSetting>
  )
}
