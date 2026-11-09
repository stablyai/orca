import { ActiveSettingsSectionProvider } from '../section-layout/SettingsSection'
import { SettingsContentScrollElementProvider } from './settings-content-scroll-element'
import { SettingsSidebar } from '../navigation/SettingsSidebar'
import { PluginInstallTrustDialogHost } from '../../plugins/dialogs/PluginInstallTrustDialog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
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
  renderSessionHistorySettingsSection,
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
  renderChatSettingsSection,
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
import {
  SettingsHostScopePicker,
  shouldShowSettingsHostScopePicker
} from '../host-scope/SettingsHostScopePicker'

export function renderSettingsLoading(
  interactions: SettingsInteractionController,
  t: Translate = translate
): React.JSX.Element {
  return (
    <div
      ref={interactions.setSettingsRootNode}
      className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background"
    >
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        {t('auto.components.settings.Settings.c7ad095d96', 'Loading settings...')}
      </div>
    </div>
  )
}

export function renderSettingsPage(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
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
        // Deep-linked panes/modals own focus; plain entry focuses search.
        searchAutoFocus={model.settingsNavigationTarget == null}
        onBack={interactions.closeSettingsPageWithPromptGuard}
        onSelectSection={actions.scrollToSection}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!model.isWebClient &&
        shouldShowSettingsHostScopePicker(model.settingsHostScope, model.runtimeEnvironments) ? (
          <SettingsHostScopePicker
            scope={model.settingsHostScope}
            environments={model.runtimeEnvironments}
            onChoose={model.setSettingsHostChoice}
          />
        ) : null}
        <div
          ref={interactions.setContentScrollNode}
          className={cn(
            'min-h-0 flex-1',
            // Why a stable gutter: pages that start or stop scrolling must not shift sideways.
            view.isFocusedShortcutsPane
              ? 'overflow-hidden'
              : 'overflow-y-auto scrollbar-sleek [scrollbar-gutter:stable]'
          )}
        >
          <div
            className={cn(
              'mx-auto flex w-full flex-col gap-10 px-8 pt-10',
              view.isFocusedShortcutsPane ? 'h-full pb-6' : 'pb-24',
              view.isFocusedSetupGuidePane || view.isWidePluginsPane ? 'max-w-6xl' : 'max-w-4xl'
            )}
          >
            {navigation.visibleNavSections.length === 0 ? (
              <div className="flex min-h-[24rem] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
                {t(
                  'auto.components.settings.Settings.noSettingsFoundForQuery',
                  'No settings found for "{{value0}}"',
                  { value0: model.settingsSearchQuery.trim() }
                )}
              </div>
            ) : (
              <SettingsContentScrollElementProvider value={interactions.contentScrollElement}>
                <ActiveSettingsSectionProvider value={model.activeSectionId}>
                  {renderAgentsSettingsSection(context, t)}
                  {renderAccountsSettingsSection(context, t)}
                  {renderOrchestrationSettingsSection(context, t)}
                  {renderLinearSettingsSection(context, t)}
                  {renderDesktopCapabilitySettingsSections(context, t)}
                  {renderOrcaAccountSettingsSection(context, t)}
                  {renderSetupGuideSettingsSection(context, t)}
                  {renderGeneralSettingsSection(context, t)}
                  {renderIntegrationsSettingsSection(context, t)}
                  {renderMobileSettingsSection(context, t)}
                  {renderAutomationsSettingsSection(context, t)}
                  {renderArtifactsSettingsSection(context, t)}
                  {renderShareSkillsSettingsSection(context, t)}
                  {renderSessionHistorySettingsSection(context, t)}
                  {renderGitSettingsSection(context, t)}
                  {renderTasksSettingsSection(context, t)}
                  {renderTerminalSettingsSection(context, t)}
                  {renderQuickCommandsSettingsSection(context, t)}
                  {renderBrowserSettingsSection(context, t)}
                  {renderMobileEmulatorSettingsSection(context, t)}
                  {renderFloatingWorkspaceSettingsSection(context, t)}
                  {renderAppearanceSettingsSection(context, t)}
                  {renderChatSettingsSection(context)}
                  {renderInputSettingsSection(context, t)}
                  {renderNotificationsSettingsSection(context, t)}
                  {renderShortcutsSettingsSection(context, t)}
                  {renderStatsSettingsSection(context, t)}
                  {renderServersSettingsSection(context, t)}
                  {renderSshSettingsSection(context, t)}
                  {renderDeveloperPermissionsSettingsSection(context, t)}
                  {renderPrivacySettingsSection(context, t)}
                  {renderAdvancedSettingsSection(context, t)}
                  {renderDevSettingsSection(context, t)}
                  {renderExperimentalSettingsSection(context, t)}
                  {renderPluginsSettingsSection(context)}
                  {renderProjectSettingsSections(context, t)}
                </ActiveSettingsSectionProvider>
              </SettingsContentScrollElementProvider>
            )}
          </div>
        </div>
      </div>
      {/* Why page level: Plugins and the Appearance theme pickers both install through it. */}
      <PluginInstallTrustDialogHost />
    </div>
  )
}
