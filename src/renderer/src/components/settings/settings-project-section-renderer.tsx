import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getRepoHostIdentity } from '../../store/slices/repo-host-identity'
import { RepositoryPane } from './RepositoryPane'
import { SettingsSection } from './SettingsSection'
import { getSettingsProjectHostRepo } from './settings-project-list'
import { translate } from '@/i18n/i18n'
import type { SettingsRenderContext } from './settings-render-context'

export function renderProjectSettingsSections(context: SettingsRenderContext): React.ReactNode {
  const { model, navigation, terminal, view } = context
  return model.settingsProjectList.map((settingsProject) => {
    const repoSectionId = `repo-${settingsProject.representativeRepoId}`
    // Why: use the switcher-selected host's repo so identity/host-specific edits follow "Available Hosts".
    const repo = getSettingsProjectHostRepo(
      settingsProject,
      model.repos,
      model.settingsProjectHostSelection[settingsProject.projectId],
      model.settingsProjectSetupSelection[settingsProject.projectId]
    )
    if (!repo) {
      return null
    }
    const repoHostIdentity = getRepoHostIdentity(repo)
    const repoHooksState = model.repoHooksMap[repoHostIdentity]
    const project = navigation.projectByRepoId.get(repo.id) ?? settingsProject.project

    return (
      <SettingsSection
        key={repoSectionId}
        id={repoSectionId}
        title={translate(
          'auto.components.settings.Settings.3bf149e873',
          'Project Settings > {{value0}}',
          { value0: project.displayName }
        )}
        description={repo.path}
        searchEntries={navigation.getSectionSearchEntries(repoSectionId)}
      >
        {view.isSectionMounted(repoSectionId) ? (
          // Why: re-key per host so same-id hosts don't reuse the prior host's drafts/effects.
          <RepositoryPane
            key={repoHostIdentity}
            repo={repo}
            yamlHooks={repoHooksState?.hooks ?? null}
            hasHooksFile={repoHooksState?.hasHooks ?? false}
            hooksInspectionReady={Boolean(repoHooksState)}
            mayNeedUpdate={repoHooksState?.mayNeedUpdate ?? false}
            updateRepo={model.updateRepo}
            removeProject={() => void model.removeProjectAllHosts(settingsProject.setups)}
            project={project}
            selectedProjectSetupId={model.settingsProjectSetupSelection[settingsProject.projectId]}
            isLocalWindowsProject={
              getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
              terminal.isWindowsTerminalHost
            }
            wslAvailable={terminal.windowsTerminalCapabilities.wslAvailable}
            wslDistros={terminal.windowsTerminalCapabilities.wslDistros}
            wslCapabilitiesLoading={terminal.windowsTerminalCapabilities.isLoading}
            updateProject={model.updateProject}
          />
        ) : null}
      </SettingsSection>
    )
  })
}
