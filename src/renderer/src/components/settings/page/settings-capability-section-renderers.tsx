import { AccountsPane } from '../accounts/AccountsPane'
import { getProviderAccountsOwnerKey } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { AgentsPane } from '../agents/AgentsPane'
import { AgentDefaultSurfaceSection } from '../agents/surfaces/AgentDefaultSurfaceSection'
import { ComputerUsePane } from '../computer-use/ComputerUsePane'
import { LinearAgentSkillPane } from '../skills/linear/LinearAgentSkillPane'
import { OrchestrationPane } from '../orchestration/OrchestrationPane'
import { VoicePane } from '../voice/VoicePane'
import { SettingsSection } from '../section-layout/SettingsSection'
import { SettingsHostScopeUnavailableNotice } from '../host-scope/SettingsHostScopePicker'
import { LOCAL_SETTINGS_HOST_SCOPE } from '../host-scope/settings-host-scope'
import { wslHostDistroForTarget } from '@/runtime/provider-accounts/ownership/wsl-host-account-owner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsRenderContext } from './settings-render-context'

export function renderAgentsSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, terminal, view } = context
  return (
    <SettingsSection
      id="agents"
      grouped
      title={t('auto.components.settings.Settings.8afa676615', 'Agents')}
      description={t(
        'auto.components.settings.Settings.ec1ba547f7',
        'Manage AI agents, set a default, and customize commands.'
      )}
      searchEntries={navigation.getSectionSearchEntries('agents')}
    >
      {view.isSectionMounted('agents') ? (
        <div className="space-y-8">
          {model.settingsHostScope.target.kind === 'local' ? (
            <AgentDefaultSurfaceSection settings={model.settings} />
          ) : null}
          <AgentsPane
            settings={model.settings}
            updateSettings={model.updateSettings}
            hostScope={model.settingsHostScope}
            wslSupportedPlatform={terminal.localWslSupportedPlatform}
            wslAvailable={terminal.localWindowsRuntimeCapabilities.wslAvailable}
            wslDistros={terminal.localWindowsRuntimeCapabilities.wslDistros}
            wslCapabilitiesLoading={terminal.localWindowsRuntimeCapabilities.isLoading}
          />
        </div>
      ) : null}
    </SettingsSection>
  )
}

export function renderAccountsSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, terminal, view } = context
  const wslHostDistro = wslHostDistroForTarget(
    model.settingsHostScope.target,
    model.runtimeEnvironments
  )
  return (
    <SettingsSection
      id="accounts"
      grouped
      title={t('auto.components.settings.Settings.ad6c529693', 'AI Provider Accounts')}
      description={t(
        'auto.components.settings.Settings.21f09426ea',
        'Optional. Orca works with your existing provider logins; add accounts only if you want Orca to help switch between them.'
      )}
      badge={t('auto.hooks.useSettingsNavigationMetadata.7c79d3b7bf', 'Optional')}
      searchEntries={navigation.getSectionSearchEntries('accounts')}
    >
      {!view.isSectionMounted('accounts') ? null : !model.settingsHostScope.available ? (
        <SettingsHostScopeUnavailableNotice />
      ) : wslHostDistro ? (
        // A WSL host's orcad has no account services; this desktop owns its distro's accounts.
        <AccountsPane
          key={wslHostDistro ?? getProviderAccountsOwnerKey(model.settingsHostScope.target)}
          nativeAccounts={model.nativeAccounts}
          onAccountLocationChange={model.releaseNativeAccounts}
          settings={model.settings}
          updateSettings={model.updateSettings}
          updateSettingsOrThrow={model.updateSettingsOrThrow}
          hostScope={LOCAL_SETTINGS_HOST_SCOPE}
          wslHostDistro={wslHostDistro}
          wslSupportedPlatform={terminal.localWslSupportedPlatform}
          wslAvailable={terminal.localWindowsRuntimeCapabilities.wslAvailable}
          wslDistros={terminal.localWindowsRuntimeCapabilities.wslDistros}
          wslCapabilitiesLoading={terminal.localWindowsRuntimeCapabilities.isLoading}
        />
      ) : (
        <AccountsPane
          key={wslHostDistro ?? getProviderAccountsOwnerKey(model.settingsHostScope.target)}
          nativeAccounts={model.nativeAccounts}
          onAccountLocationChange={model.releaseNativeAccounts}
          settings={model.settings}
          updateSettings={model.updateSettings}
          updateSettingsOrThrow={model.updateSettingsOrThrow}
          hostScope={model.settingsHostScope}
          wslSupportedPlatform={terminal.runtimeWslSupportedPlatform}
          wslAvailable={terminal.windowsTerminalCapabilities.wslAvailable}
          wslDistros={terminal.windowsTerminalCapabilities.wslDistros}
          wslCapabilitiesLoading={terminal.windowsTerminalCapabilities.isLoading}
          accountOwnerPlatform={terminal.windowsTerminalCapabilities.hostPlatform}
        />
      )}
    </SettingsSection>
  )
}

export function renderOrchestrationSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="orchestration"
      grouped
      title={t('auto.components.settings.Settings.00c3a7950d', 'Orchestration')}
      description={t(
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
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.linearConnected ? (
    <SettingsSection
      id="linear"
      grouped
      title={t('auto.components.settings.Settings.linearTitle', 'Linear')}
      description={t(
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
  context: SettingsRenderContext,
  t: Translate = translate
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings ? (
    <>
      <SettingsSection
        id="computer-use"
        grouped
        title={t('auto.components.settings.Settings.c9841721cb', 'Computer Use')}
        description={t(
          'auto.components.settings.Settings.7118953f14',
          'Enable agents to control any app on your computer.'
        )}
        searchEntries={navigation.getSectionSearchEntries('computer-use')}
      >
        {view.isSectionMounted('computer-use') ? <ComputerUsePane /> : null}
      </SettingsSection>

      <SettingsSection
        id="voice"
        title={t('auto.components.settings.Settings.5063bb47a5', 'Voice')}
        description={t(
          'components.settings.voice.sectionDescription',
          'Talk instead of typing in any pane. Speech is recognized on this computer unless you pick a cloud model.'
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
