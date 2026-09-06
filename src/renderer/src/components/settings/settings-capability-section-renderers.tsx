import { AccountsPane } from './AccountsPane'
import { AgentsPane } from './AgentsPane'
import { ComputerUsePane } from './ComputerUsePane'
import { LinearAgentSkillPane } from './LinearAgentSkillPane'
import { OrchestrationPane } from './OrchestrationPane'
import { VoicePane } from './VoicePane'
import { SettingsSection } from './SettingsSection'
import { translate } from '@/i18n/i18n'
import type { SettingsRenderContext } from './settings-render-context'

export function renderAgentsSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { model, navigation, terminal, view } = context
  return (
    <SettingsSection
      id="agents"
      title={translate('auto.components.settings.Settings.8afa676615', 'Agents')}
      description={translate(
        'auto.components.settings.Settings.ec1ba547f7',
        'Manage AI agents, set a default, and customize commands.'
      )}
      searchEntries={navigation.getSectionSearchEntries('agents')}
    >
      {view.isSectionMounted('agents') ? (
        <AgentsPane
          settings={model.settings}
          updateSettings={model.updateSettings}
          wslSupportedPlatform={terminal.localWslSupportedPlatform}
          wslAvailable={terminal.localWindowsRuntimeCapabilities.wslAvailable}
          wslDistros={terminal.localWindowsRuntimeCapabilities.wslDistros}
          wslCapabilitiesLoading={terminal.localWindowsRuntimeCapabilities.isLoading}
        />
      ) : null}
    </SettingsSection>
  )
}

export function renderAccountsSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { model, navigation, terminal, view } = context
  return (
    <SettingsSection
      id="accounts"
      title={translate('auto.components.settings.Settings.ad6c529693', 'AI Provider Accounts')}
      description={translate(
        'auto.components.settings.Settings.21f09426ea',
        'Optional. Orca works with your existing provider logins; add accounts only if you want Orca to help switch between them.'
      )}
      badge={translate('auto.hooks.useSettingsNavigationMetadata.7c79d3b7bf', 'Optional')}
      searchEntries={navigation.getSectionSearchEntries('accounts')}
    >
      {view.isSectionMounted('accounts') ? (
        <AccountsPane
          settings={model.settings}
          updateSettings={model.updateSettings}
          wslSupportedPlatform={terminal.runtimeWslSupportedPlatform}
          wslAvailable={terminal.windowsTerminalCapabilities.wslAvailable}
          wslDistros={terminal.windowsTerminalCapabilities.wslDistros}
          wslCapabilitiesLoading={terminal.windowsTerminalCapabilities.isLoading}
          accountOwnerPlatform={terminal.windowsTerminalCapabilities.hostPlatform}
        />
      ) : null}
    </SettingsSection>
  )
}

export function renderOrchestrationSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="orchestration"
      title={translate('auto.components.settings.Settings.00c3a7950d', 'Orchestration')}
      description={translate(
        'auto.components.settings.Settings.475980f53d',
        'Coordinate multiple coding agents through Orca.'
      )}
      searchEntries={navigation.getSectionSearchEntries('orchestration')}
    >
      {view.isSectionMounted('orchestration') ? (
        <OrchestrationPane settings={model.settings} updateSettings={model.updateSettings} />
      ) : null}
    </SettingsSection>
  )
}

export function renderLinearSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.linearConnected ? (
    <SettingsSection
      id="linear"
      title={translate('auto.components.settings.Settings.linearTitle', 'Linear')}
      description={translate(
        'auto.components.settings.Settings.linearDescription',
        'How Linear works in Orca, setup checklist, agent skill, and example prompts.'
      )}
      searchEntries={navigation.getSectionSearchEntries('linear')}
    >
      {view.isSectionMounted('linear') ? <LinearAgentSkillPane /> : null}
    </SettingsSection>
  ) : null
}

export function renderDesktopCapabilitySettingsSections(
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <>
      <SettingsSection
        id="computer-use"
        title={translate('auto.components.settings.Settings.c9841721cb', 'Computer Use')}
        description={translate(
          'auto.components.settings.Settings.7118953f14',
          'Enable agents to control any app on your computer.'
        )}
        searchEntries={navigation.getSectionSearchEntries('computer-use')}
      >
        {view.isSectionMounted('computer-use') ? <ComputerUsePane /> : null}
      </SettingsSection>

      <SettingsSection
        id="voice"
        title={translate('auto.components.settings.Settings.5063bb47a5', 'Voice')}
        description={translate(
          'auto.components.settings.Settings.eb1176a14e',
          'Local speech-to-text dictation with on-device models.'
        )}
        searchEntries={navigation.getSectionSearchEntries('voice')}
      >
        {view.isSectionMounted('voice') ? (
          <VoicePane settings={model.settings} updateSettings={model.updateSettings} />
        ) : null}
      </SettingsSection>
    </>
  ) : null
}
