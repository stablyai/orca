import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Project, ProjectUpdateArgs } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { ProjectTerminalBackendSetting } from './ProjectTerminalBackendSetting'
import type { ProjectRuntimeSessionSummary } from './repository-runtime-session-summary'

type RepositoryTerminalBackendSectionProps = {
  repo: Repo
  settings: GlobalSettings
  project: Project
  hostId: ExecutionHostId
  runtimeSessionSummary?: ProjectRuntimeSessionSummary
  updateProject: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
  forceVisible: boolean
}

export function RepositoryTerminalBackendSection({
  repo,
  settings,
  project,
  hostId,
  runtimeSessionSummary,
  updateProject,
  forceVisible
}: RepositoryTerminalBackendSectionProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.RepositoryPane.terminalBackend',
        'Terminal backend'
      )}
      description={translate(
        'auto.components.settings.RepositoryPane.terminalBackendDescription',
        'Choose Orca or Herdr for this project.'
      )}
      keywords={[repo.displayName, 'terminal', 'backend', 'runtime', 'herdr', 'multiplexer']}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <ProjectTerminalBackendSetting
        project={project}
        hostId={hostId}
        settings={settings}
        runtimeSessionSummary={runtimeSessionSummary}
        updateProject={updateProject}
      />
    </SearchableSetting>
  )
}
