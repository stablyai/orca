import { ProjectGroupingSetting } from './ProjectGroupingSetting'
import { RepositoryHostSetupsSection } from './repository/execution/RepositoryHostSetupsSection'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { RepositorySettingsSession } from './repository/RepositorySettingsSession'
import { RepositoryPane } from './repository/RepositoryPane'
import { SettingsSection } from './SettingsSection'
import {
  getSettingsEntryHostSelection,
  getSettingsProjectHostRepo,
  getSettingsProjectSelectedSetup,
  getSettingsProjectRemovalScope
} from './settings-project-list'
import { translate } from '@/i18n/i18n'
import type { SettingsRenderContext } from './settings-render-context'

export function renderProjectSettingsSections(context: SettingsRenderContext): React.ReactNode {
  const { model, navigation, terminal, view } = context
  return model.settingsProjectList.map((settingsProject) => {
    const repoSectionId = `repo-${settingsProject.selectionKey}`
    // Identity edits must follow the selected Available Hosts entry.
    const hostSelection = getSettingsEntryHostSelection(
      settingsProject,
      model.settingsProjectHostSelection,
      model.settingsProjectSetupSelection
    )
    const repo = getSettingsProjectHostRepo(
      settingsProject,
      model.repos,
      hostSelection.hostId,
      hostSelection.setupId
    )
    const setup = getSettingsProjectSelectedSetup(
      settingsProject,
      hostSelection.hostId,
      hostSelection.setupId
    )
    if (!setup || model.activeSectionId !== repoSectionId) {
      return null
    }
    const repoHostIdentity = getRepoHostIdentityForParts(setup.repoId, setup.hostId)
    const repoHooksState = model.repoHooksMap[repoHostIdentity]
    const project = settingsProject.project

    return (
      <RepositorySettingsSession
        key={repoHostIdentity}
        repo={repo}
        repoId={setup.repoId}
        hostId={setup.hostId}
        isFolder={project.kind === 'folder'}
        updateRepo={model.updateRepo}
      >
        {(session) =>
          !repo || view.isSectionMounted(repoSectionId) ? (
            <SettingsSection
              forceVisible={!repo}
              id={repoSectionId}
              title={translate(
                'auto.components.settings.Settings.3bf149e873',
                'Project Settings > {{value0}}',
                { value0: settingsProject.checkoutLabel ?? project.displayName }
              )}
              description={repo?.path ?? setup.path}
              searchEntries={navigation.getSectionSearchEntries(repoSectionId)}
            >
              {!repo ? (
                <div className="space-y-8">
                  {model.settings && project.kind !== 'folder' ? (
                    <ProjectGroupingSetting
                      settings={model.settings}
                      updateSettings={model.updateSettings}
                      projectId={project.id}
                    />
                  ) : null}
                  <RepositoryHostSetupsSection
                    project={project}
                    retainedSetups={settingsProject.setups}
                    selectedProjectSetupId={hostSelection.setupId}
                    selectedProjectHostId={hostSelection.hostId}
                    settingsSelectionKey={settingsProject.selectionKey}
                    settingsEntryRepoIds={
                      new Set(settingsProject.setups.map((setup) => setup.repoId))
                    }
                    forceVisible
                    searchQuery=""
                    searchEntries={navigation.getSectionSearchEntries(repoSectionId)}
                  />
                </div>
              ) : (
                // The concrete ancestor owns inputs; only current source-backed views mount.
                <RepositoryPane
                  session={session}
                  repo={repo}
                  yamlHooks={repoHooksState?.hooks ?? null}
                  hasHooksFile={repoHooksState?.hasHooks ?? false}
                  hooksInspectionReady={Boolean(repoHooksState)}
                  mayNeedUpdate={repoHooksState?.mayNeedUpdate ?? false}
                  updateRepo={model.updateRepo}
                  removeProject={() => void model.removeProjectAllHosts(settingsProject.setups)}
                  project={project}
                  selectedProjectSetupId={hostSelection.setupId}
                  settingsSelectionKey={settingsProject.selectionKey}
                  settingsEntryRepoIds={
                    settingsProject.splitProject
                      ? new Set(settingsProject.setups.map((setup) => setup.repoId))
                      : undefined
                  }
                  removalScope={getSettingsProjectRemovalScope(settingsProject)}
                  isLocalWindowsProject={
                    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
                    terminal.isWindowsTerminalHost
                  }
                  wslAvailable={terminal.windowsTerminalCapabilities.wslAvailable}
                  wslDistros={terminal.windowsTerminalCapabilities.wslDistros}
                  wslCapabilitiesLoading={terminal.windowsTerminalCapabilities.isLoading}
                  updateProject={(projectId, updates) =>
                    model.updateProject(projectId, updates, getRepoExecutionHostId(repo))
                  }
                />
              )}
            </SettingsSection>
          ) : null
        }
      </RepositorySettingsSession>
    )
  })
}
