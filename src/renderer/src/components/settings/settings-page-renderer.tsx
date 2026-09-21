import { ActiveSettingsSectionProvider } from './SettingsSection'
import { SettingsSidebar } from './SettingsSidebar'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsRenderContext } from './settings-render-context'
import {
  renderAccountsSettingsSection,
  renderAgentsSettingsSection,
  renderDesktopCapabilitySettingsSections,
  renderLinearSettingsSection,
  renderOrchestrationSettingsSection
} from './settings-capability-section-renderers'
import {
  renderArtifactsSettingsSection,
  renderAutomationsSettingsSection,
  renderGeneralSettingsSection,
  renderIntegrationsSettingsSection,
  renderMobileSettingsSection,
  renderOrcaAccountSettingsSection,
  renderSetupGuideSettingsSection,
  renderShareSkillsSettingsSection
} from './settings-setup-workflow-section-renderers'
import {
  renderGitSettingsSection,
  renderTasksSettingsSection
} from './settings-git-task-section-renderers'
import {
  renderBrowserSettingsSection,
  renderFloatingWorkspaceSettingsSection,
  renderMobileEmulatorSettingsSection,
  renderQuickCommandsSettingsSection,
  renderTerminalSettingsSection
} from './settings-interface-primary-section-renderers'
import {
  renderAppearanceSettingsSection,
  renderInputSettingsSection,
  renderNotificationsSettingsSection,
  renderShortcutsSettingsSection,
  renderStatsSettingsSection
} from './settings-interface-secondary-section-renderers'
import {
  renderDeveloperPermissionsSettingsSection,
  renderPrivacySettingsSection,
  renderServersSettingsSection,
  renderSshSettingsSection
} from './settings-remote-security-section-renderers'
import {
  renderAdvancedSettingsSection,
  renderDevSettingsSection,
  renderExperimentalSettingsSection,
  renderPluginsSettingsSection
} from './settings-advanced-section-renderers'
import { renderProjectSettingsSections } from './settings-project-section-renderer'

export function renderSettingsLoading(
  interactions: SettingsInteractionController
): React.JSX.Element {
  return (
    <div
      ref={interactions.setSettingsRootNode}
      className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background"
    >
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        {translate('auto.components.settings.Settings.c7ad095d96', 'Loading settings...')}
      </div>
    </div>
  )
}

export function renderSettingsPage(context: SettingsRenderContext): React.JSX.Element {
  const { model, interactions, navigation, actions, view } = context
  return (
    <div
      ref={interactions.setSettingsRootNode}
      className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background"
    >
      <SettingsSidebar
        settings={model.settings}
        activeSectionId={model.activeSectionId}
        generalGroups={view.generalNavGroups}
        repoSections={view.repoNavSections}
        hasRepos={model.repos.length > 0}
        searchInputRef={interactions.searchInputRef}
        // Why: deep-links open panes/modals that own focus; plain entry lands in search.
        searchAutoFocus={model.settingsNavigationTarget == null}
        onBack={interactions.closeSettingsPageWithPromptGuard}
        onSelectSection={actions.scrollToSection}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={interactions.setContentScrollNode}
          className={cn(
            'min-h-0 flex-1',
            view.isFocusedShortcutsPane ? 'overflow-hidden' : 'overflow-y-auto scrollbar-sleek'
          )}
        >
          <div
            className={cn(
              'mx-auto flex w-full flex-col gap-10 px-8 pt-10',
              view.isFocusedShortcutsPane ? 'h-full pb-6' : 'pb-24',
              view.isFocusedSetupGuidePane ? 'max-w-6xl' : 'max-w-4xl'
            )}
          >
            {navigation.visibleNavSections.length === 0 ? (
              <div className="flex min-h-[24rem] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.Settings.3c88ec55d6',
                  'No settings found for "'
                )}
                {model.settingsSearchQuery.trim()}
                {translate('auto.components.settings.Settings.add3b97ee6', '"')}
              </div>
            ) : (
              <ActiveSettingsSectionProvider value={model.activeSectionId}>
                {renderAgentsSettingsSection(context)}
                {renderAccountsSettingsSection(context)}
                {renderOrchestrationSettingsSection(context)}
                {renderLinearSettingsSection(context)}
                {renderDesktopCapabilitySettingsSections(context)}
                {renderOrcaAccountSettingsSection(context)}
                {renderSetupGuideSettingsSection(context)}
                {renderGeneralSettingsSection(context)}
                {renderIntegrationsSettingsSection(context)}
                {renderMobileSettingsSection(context)}
                {renderAutomationsSettingsSection(context)}
                {renderArtifactsSettingsSection(context)}
                {renderShareSkillsSettingsSection(context)}
                {renderGitSettingsSection(context)}
                {renderTasksSettingsSection(context)}
                {renderTerminalSettingsSection(context)}
                {renderQuickCommandsSettingsSection(context)}
                {renderBrowserSettingsSection(context)}
                {renderMobileEmulatorSettingsSection(context)}
                {renderFloatingWorkspaceSettingsSection(context)}
                {renderAppearanceSettingsSection(context)}
                {renderInputSettingsSection(context)}
                {renderNotificationsSettingsSection(context)}
                {renderShortcutsSettingsSection(context)}
                {renderStatsSettingsSection(context)}
                {renderServersSettingsSection(context)}
                {renderSshSettingsSection(context)}
                {renderDeveloperPermissionsSettingsSection(context)}
                {renderPrivacySettingsSection(context)}
                {renderAdvancedSettingsSection(context)}
                {renderDevSettingsSection(context)}
                {renderExperimentalSettingsSection(context)}
                {renderPluginsSettingsSection(context)}
                {renderProjectSettingsSections(context)}
              </ActiveSettingsSectionProvider>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
