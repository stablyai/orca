import { ArtifactsSettingsPane } from './ArtifactsSettingsPane'
import { AutomationsSettingsPane } from './AutomationsSettingsPane'
import { GeneralPane } from './GeneralPane'
import { IntegrationsPane } from './IntegrationsPane'
import { MobileSettingsPane } from './MobileSettingsPane'
import { OrcaAccountSettingsPane } from './OrcaAccountSettingsPane'
import { SettingsSetupGuidePane } from './SettingsSetupGuidePane'
import { ShareSkillsSettingsPane } from './ShareSkillsSettingsPane'
import { SettingsSection } from './SettingsSection'
import { translate } from '@/i18n/i18n'
import type { SettingsRenderContext } from './settings-render-context'

export function renderOrcaAccountSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <SettingsSection
      id="orca-account"
      title={translate('auto.components.settings.orcaAccount.title', 'Orca Account')}
      description={translate(
        'auto.components.settings.orcaAccount.description',
        'Share work instantly and reach your desktop from Orca Mobile wherever you are.'
      )}
      searchEntries={navigation.getSectionSearchEntries('orca-account')}
    >
      {view.isSectionMounted('orca-account') ? <OrcaAccountSettingsPane /> : null}
    </SettingsSection>
  ) : null
}

export function renderSetupGuideSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { navigation, view } = context
  return (
    <SettingsSection
      id="setup-guide"
      title={translate('auto.components.settings.Settings.6d119427ef', 'Onboarding checklist')}
      description={translate(
        'auto.components.settings.Settings.6855b0f77d',
        'Finish the core workflows that make Orca useful for parallel agent work.'
      )}
      searchEntries={navigation.getSectionSearchEntries('setup-guide')}
      bodyClassName="overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none"
    >
      {view.isSectionMounted('setup-guide') ? <SettingsSetupGuidePane /> : null}
    </SettingsSection>
  )
}

export function renderGeneralSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { model, interactions, navigation, terminal, view } = context
  return (
    <SettingsSection
      id="general"
      title={translate('auto.components.settings.Settings.7807c11c4d', 'General')}
      description={translate(
        'auto.components.settings.Settings.f9b77539fd',
        'Workspace defaults, app setup, and maintenance.'
      )}
      searchEntries={navigation.getSectionSearchEntries('general')}
    >
      {view.isSectionMounted('general') ? (
        <GeneralPane
          settings={model.settings}
          updateSettings={model.updateSettings}
          updateSettingsOrThrow={model.updateSettingsOrThrow}
          fontSuggestions={model.terminalFontSuggestions}
          onRequestFontSuggestions={interactions.requestFontSuggestions}
          wslSupportedPlatform={terminal.localWslSupportedPlatform}
          wslAvailable={terminal.localWindowsRuntimeCapabilities.wslAvailable}
          wslDistros={terminal.localWindowsRuntimeCapabilities.wslDistros}
          wslCapabilitiesLoading={terminal.localWindowsRuntimeCapabilities.isLoading}
        />
      ) : null}
    </SettingsSection>
  )
}

export function renderIntegrationsSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element {
  const { navigation, view } = context
  return (
    <SettingsSection
      id="integrations"
      title={translate('auto.components.settings.Settings.c9ca101a3b', 'Integrations')}
      description={translate(
        'auto.components.settings.Settings.b07041697f',
        'Connect GitHub, GitLab, Linear, and source-hosting services.'
      )}
      searchEntries={navigation.getSectionSearchEntries('integrations')}
      bodyClassName="rounded-none border-0 bg-transparent p-0 shadow-none"
    >
      {view.isSectionMounted('integrations') ? <IntegrationsPane /> : null}
    </SettingsSection>
  )
}

export function renderMobileSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <SettingsSection
      id="mobile"
      title={translate('auto.components.settings.Settings.c40dadaac8', 'Mobile')}
      badge="Beta"
      description={translate(
        'auto.components.settings.Settings.c6c01ac209',
        'Control terminals and agents from your phone.'
      )}
      searchEntries={navigation.getSectionSearchEntries('mobile')}
    >
      {view.isSectionMounted('mobile') ? <MobileSettingsPane /> : null}
    </SettingsSection>
  ) : null
}

export function renderAutomationsSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="automations"
      title={translate('auto.components.settings.automations.title', 'Automations')}
      description={translate(
        'auto.components.settings.automations.description',
        'Schedule agent work and choose whether Automations appears in the sidebar.'
      )}
      searchEntries={navigation.getSectionSearchEntries('automations')}
    >
      {view.isSectionMounted('automations') ? (
        <AutomationsSettingsPane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  )
}

export function renderArtifactsSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="artifacts"
      title={translate('auto.components.settings.artifacts.title', 'Artifacts')}
      badge="Beta"
      description={translate(
        'auto.components.settings.artifacts.description',
        'Share HTML and Markdown files with your team and manage their public links.'
      )}
      searchEntries={navigation.getSectionSearchEntries('artifacts')}
    >
      {view.isSectionMounted('artifacts') ? (
        <ArtifactsSettingsPane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  )
}

export function renderShareSkillsSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element {
  const { navigation, view } = context
  return (
    <SettingsSection
      id="share-skills"
      title={translate('auto.components.settings.shareSkills.title', 'Share Skills')}
      badge="Beta"
      description={translate(
        'auto.components.settings.shareSkills.description',
        'Share your skills with an unlisted link. Anyone who has it can install them.'
      )}
      searchEntries={navigation.getSectionSearchEntries('share-skills')}
    >
      {view.isSectionMounted('share-skills') ? <ShareSkillsSettingsPane /> : null}
    </SettingsSection>
  )
}
