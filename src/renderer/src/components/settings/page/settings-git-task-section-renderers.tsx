import { CommitMessageAiPane } from '../source-control/CommitMessageAiPane'
import { GitPane } from '../source-control/GitPane'
import { GitProviderApiBudgetPane } from '../source-control/GitProviderApiBudgetPane'
import { PerforcePane } from '../PerforcePane'
import { TasksPane } from '../tasks/TasksPane'
import { SettingsSection } from '../section-layout/SettingsSection'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

export function renderPerforceSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="perforce"
      title={t('perforce.settings.navTitle', 'Perforce')}
      description={t(
        'perforce.settings.navDescription',
        'Connection, Source Control behavior, changelists, and shelves.'
      )}
      searchEntries={navigation.getSectionSearchEntries('perforce')}
    >
      {view.isSectionMounted('perforce') ? (
        <PerforcePane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  )
}

export function renderGitSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, interactions, navigation, view } = context
  return (
    <SettingsSection
      id="git"
      grouped
      title={t('auto.components.settings.Settings.d09b9d8f00', 'Git & source control')}
      description={t(
        'auto.components.settings.Settings.cfa34f4465',
        'Branch naming, base refs, and Git AI Author.'
      )}
      searchEntries={navigation.getSectionSearchEntries('git')}
      forceVisible={model.hasUnsavedCommitPromptChanges || model.hasUnsavedBranchPromptChanges}
    >
      {view.isSectionMounted('git') ? (
        <>
          <GitPane
            settings={model.settings}
            updateSettings={model.updateSettings}
            writeSourceControlAiSettings={interactions.writeSourceControlAiSettings}
            displayedGitUsername={navigation.displayedGitUsername}
            hasUnsavedBranchPromptChanges={model.hasUnsavedBranchPromptChanges}
            onBranchPromptDirtyChange={model.setHasUnsavedBranchPromptChanges}
            branchPromptDiscardSignal={model.sourceControlAiPromptDiscardSignal}
            settingsSearchQuery={model.settingsSearchQuery}
          />
          <CommitMessageAiPane
            settings={model.settings}
            updateSettings={model.updateSettings}
            writeSourceControlAiSettings={interactions.writeSourceControlAiSettingsOrThrow}
            onCustomPromptDirtyChange={model.setHasUnsavedCommitPromptChanges}
            customPromptDiscardSignal={model.sourceControlAiPromptDiscardSignal}
            settingsSearchQuery={model.settingsSearchQuery}
          />
          <GitProviderApiBudgetPane
            settingsSearchQuery={model.settingsSearchQuery}
            target={model.settingsHostScope.target}
          />
        </>
      ) : null}
    </SettingsSection>
  )
}

export function renderTasksSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="tasks"
      grouped
      title={t('auto.components.settings.Settings.c0900fa64a', 'Task sources')}
      description={t(
        'auto.components.settings.Settings.tasksDescription',
        'Connect providers, install the Linear skill, and choose what appears in Tasks.'
      )}
      searchEntries={navigation.getSectionSearchEntries('tasks')}
    >
      {view.isSectionMounted('tasks') ? (
        <TasksPane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  )
}
