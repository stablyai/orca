import { DeveloperPermissionsPane } from './DeveloperPermissionsPane'
import { PrivacyPane } from './PrivacyPane'
import { RuntimeEnvironmentsPane } from './RuntimeEnvironmentsPane'
import { RuntimeServersHeaderActions } from './runtime-servers-header-actions'
import { RuntimeServersPageProvider } from './runtime-servers-page-context'
import { SshPane } from './SshPane'
import { SshHostsHeaderSlot, SshHostsHeaderSlotProvider } from './ssh-hosts-header-slot'
import { SettingsSection } from './SettingsSection'
import { translate } from '@/i18n/i18n'
import type { SettingsRenderContext } from './settings-render-context'

export function renderServersSettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { model, navigation, view } = context
  const mounted = view.isSectionMounted('servers')
  return (
    <RuntimeServersPageProvider>
      <SettingsSection
        id="servers"
        title={translate('auto.components.settings.Settings.bd0181eeca', 'Remote Orca Servers')}
        description={
          model.isWebClient
            ? translate(
                'auto.components.settings.Settings.7686cb5c36',
                'Connect this browser to a saved Orca server.'
              )
            : translate(
                'auto.components.settings.Settings.remoteServersDescription',
                'Run Orca on another machine and work on it from here.'
              )
        }
        searchEntries={navigation.getSectionSearchEntries('servers')}
        headerAction={
          mounted ? (
            <RuntimeServersHeaderActions canGeneratePairingUrl={!model.isWebClient} />
          ) : undefined
        }
        // Why unframed: the server list and cards are the page's own surfaces; a band around them nests cards.
        bodyClassName="rounded-none border-0 bg-transparent px-0 py-0 shadow-none"
      >
        {mounted ? (
          <RuntimeEnvironmentsPane
            settings={model.settings}
            setActiveRuntimeEnvironmentPreference={model.setActiveRuntimeEnvironmentPreference}
            canGeneratePairingUrl={!model.isWebClient}
            allowLocalRuntime={!model.isWebClient}
            addServerIntentSignal={model.remoteServerAddIntentSignal}
          />
        ) : null}
      </SettingsSection>
    </RuntimeServersPageProvider>
  )
}

export function renderSshSettingsSection(context: SettingsRenderContext): React.JSX.Element | null {
  const { model, navigation, view } = context
  const mounted = view.isSectionMounted('ssh')
  return model.showDesktopOnlySettings ? (
    <SshHostsHeaderSlotProvider>
      <SettingsSection
        id="ssh"
        title={translate('auto.components.settings.Settings.9b02492d1f', 'SSH Hosts')}
        description={translate(
          'auto.components.settings.Settings.c2ee313198',
          'Use existing machines over SSH for files, terminals, Git, and workspaces.'
        )}
        searchEntries={navigation.getSectionSearchEntries('ssh')}
        headerAction={mounted ? <SshHostsHeaderSlot /> : undefined}
        // Why unframed: the host groups are the page's own surfaces; a band around them nests cards.
        bodyClassName="rounded-none border-0 bg-transparent px-0 py-0 shadow-none"
      >
        {mounted ? <SshPane addTargetIntentSignal={model.sshHostAddIntentSignal} /> : null}
      </SettingsSection>
    </SshHostsHeaderSlotProvider>
  ) : null
}

export function renderDeveloperPermissionsSettingsSection(
  context: SettingsRenderContext
): React.JSX.Element | null {
  const { model, navigation, view } = context
  return model.showDesktopOnlySettings && model.isMac ? (
    <SettingsSection
      id="developer-permissions"
      title={translate('auto.components.settings.Settings.65660d4548', 'macOS Permissions')}
      description={translate(
        'auto.components.settings.Settings.9b83cc62c2',
        'macOS privacy access for terminal-launched developer tools.'
      )}
      searchEntries={navigation.getSectionSearchEntries('developer-permissions')}
    >
      {view.isSectionMounted('developer-permissions') ? (
        <DeveloperPermissionsPane highlightedSettingId={model.highlightedSettingsTargetId} />
      ) : null}
    </SettingsSection>
  ) : null
}

export function renderPrivacySettingsSection(context: SettingsRenderContext): React.JSX.Element {
  const { model, navigation, view } = context
  return (
    <SettingsSection
      id="privacy"
      title={translate('auto.components.settings.Settings.d7e3f62d70', 'Privacy & Telemetry')}
      description={translate(
        'auto.components.settings.Settings.c1b43dc4e2',
        'Anonymous usage data and telemetry controls.'
      )}
      searchEntries={navigation.getSectionSearchEntries('privacy')}
    >
      {view.isSectionMounted('privacy') ? <PrivacyPane settings={model.settings} /> : null}
    </SettingsSection>
  )
}
