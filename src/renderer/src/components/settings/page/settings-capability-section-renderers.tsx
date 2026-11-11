import { AccountsPane } from '../accounts/AccountsPane'
import { AgentAccountsJumpRow } from '../accounts/AgentAccountsJumpRow'
import {
  AgentAccountsSubsection,
  type AgentAccountsPart
} from '../accounts/AgentAccountsSubsection'
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

/** The "This computer" / "Selected host" part of Settings → Agent accounts. */
export const AGENT_ACCOUNTS_HOST_PART_ID = 'accounts-this-host'

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

/**
 * Settings → Agent accounts: one page for agent sign-ins. "This computer" (or the host picked in the
 * scope picker) holds provider accounts, switching and usage; `additionalParts` lets a build add
 * more parts below it. With more than one part, a jump row under the description links to each.
 */
export function renderAccountsSettingsSection(
  context: SettingsRenderContext,
  t: Translate = translate,
  additionalParts: readonly AgentAccountsPart[] = []
): React.JSX.Element {
  const { model, navigation, view } = context
  const isLocalScope = model.settingsHostScope.target.kind === 'local'
  const hostPartTitle = isLocalScope
    ? t('settings.agentAccounts.thisComputer', 'This computer')
    : t('settings.agentAccounts.selectedHost', 'Selected host')
  return (
    <SettingsSection
      id="accounts"
      grouped
      title={t('auto.components.settings.Settings.4198aae333', 'Agent accounts')}
      description={t(
        'settings.agentAccounts.pageDescription',
        'Sign-ins, account switching and usage for your agents.'
      )}
      searchEntries={navigation.getSectionSearchEntries('accounts')}
    >
      {view.isSectionMounted('accounts') ? (
        <>
          <AgentAccountsJumpRow
            links={[
              { id: AGENT_ACCOUNTS_HOST_PART_ID, title: hostPartTitle },
              ...additionalParts.map(({ id, title }) => ({ id, title }))
            ]}
          />
          <AgentAccountsSubsection
            id={AGENT_ACCOUNTS_HOST_PART_ID}
            title={hostPartTitle}
            description={t(
              'auto.components.settings.Settings.21f09426ea',
              'Optional. Orca works with your existing provider logins; add accounts only if you want Orca to help switch between them.'
            )}
          >
            {renderProviderAccountsPane(context)}
          </AgentAccountsSubsection>
          {additionalParts.map((part) => (
            <AgentAccountsSubsection
              key={part.id}
              id={part.id}
              title={part.title}
              description={part.description}
            >
              {part.content}
            </AgentAccountsSubsection>
          ))}
        </>
      ) : null}
    </SettingsSection>
  )
}

function renderProviderAccountsPane(context: SettingsRenderContext): React.JSX.Element {
  const { model, terminal } = context
  const wslHostDistro = wslHostDistroForTarget(
    model.settingsHostScope.target,
    model.runtimeEnvironments
  )
  return !model.settingsHostScope.available ? (
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
        title={t('auto.components.settings.Settings.3f3e11cb5d', 'Computer use')}
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
        grouped
        title={t('auto.components.settings.Settings.5063bb47a5', 'Voice')}
        description={t(
          'components.settings.voice.pageDescription',
          'Talk instead of typing in any pane.'
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
