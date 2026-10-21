import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentCacheTimerSection } from './AgentCacheTimerSection'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
import { CodexTerminalServerIsolationSetting } from './CodexTerminalServerIsolationSetting'
import {
  getAgentGeneratedTabTitlesDescription,
  getAgentGeneratedTabTitlesTitle
} from './agent-generated-tab-title-copy'
import { getAgentStatusHooksDescription, getAgentStatusHooksTitle } from './agent-status-hooks-copy'
import {
  getAgentWorkspaceTrustDescription,
  getAgentWorkspaceTrustTitle
} from './agent-workspace-trust-copy'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { getAgentsPaneSearchEntries } from './agents-search'
import {
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue
} from './agent-availability-settings'
import { AgentAvailabilityControl } from './AgentCatalogRow'
import { AgentLaunchSettingsSection } from './AgentLaunchSettingsSection'
import {
  AgentPermissionsSetting,
  type AgentPermissionsSettingProps
} from './AgentPermissionsSetting'
import type { SettingsHostScope } from './settings-host-scope'

export {
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue,
  getAgentsPaneSearchEntries,
  AgentAvailabilityControl,
  AgentPermissionsSetting
}

type AgentSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

type AgentsPaneProps = AgentSettingProps & {
  /** Host whose agent launch settings and detected agents the pane shows. */
  hostScope: SettingsHostScope
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

export function AgentsPane({
  settings,
  updateSettings,
  hostScope,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading
}: AgentsPaneProps): React.JSX.Element {
  const refreshLocalAgents = useAppStore((state) => state.refreshDetectedAgents)
  return (
    <div className="space-y-8">
      <AgentLaunchSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        hostScope={hostScope}
        renderPermissions={renderAgentPermissions}
      />
      <section className="space-y-8">
        <SettingsSubsectionHeader title={getLocalExecutionHostLabel()} />
        <AgentRuntimeSetting
          settings={settings}
          updateSettings={updateSettings}
          refresh={refreshLocalAgents}
          wslSupportedPlatform={wslSupportedPlatform}
          wslAvailable={wslAvailable}
          wslDistros={wslDistros}
          wslCapabilitiesLoading={wslCapabilitiesLoading}
        />
        <AgentStatusHooksSetting settings={settings} updateSettings={updateSettings} />
        {!isPairedWebClientWindow() ? (
          <>
            <AgentWorkspaceTrustSetting settings={settings} updateSettings={updateSettings} />
            <CodexTerminalServerIsolationSetting
              settings={settings}
              updateSettings={updateSettings}
            />
          </>
        ) : null}
        <AgentGeneratedTabTitlesSetting settings={settings} updateSettings={updateSettings} />
        {!isPairedWebClientWindow() ? (
          <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />
        ) : null}
        <AgentCacheTimerSection settings={settings} updateSettings={updateSettings} />
      </section>
    </div>
  )
}

function renderAgentPermissions(props: AgentPermissionsSettingProps): React.ReactNode {
  return <AgentPermissionsSetting {...props} />
}

export function AgentStatusHooksSetting({ settings, updateSettings }: AgentSettingProps) {
  const enabled = settings.agentStatusHooksEnabled !== false
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentStatusHooksTitle()}
        description={getAgentStatusHooksDescription()}
        checked={enabled}
        onChange={() => updateSettings({ agentStatusHooksEnabled: !enabled })}
        ariaLabel={getAgentStatusHooksTitle()}
      />
    </section>
  )
}

export function AgentWorkspaceTrustSetting({ settings, updateSettings }: AgentSettingProps) {
  const enabled = settings.agentWorkspaceTrustEnabled !== false
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentWorkspaceTrustTitle()}
        description={getAgentWorkspaceTrustDescription()}
        checked={enabled}
        onChange={() => updateSettings({ agentWorkspaceTrustEnabled: !enabled })}
        ariaLabel={getAgentWorkspaceTrustTitle()}
      />
    </section>
  )
}

export function AgentGeneratedTabTitlesSetting({ settings, updateSettings }: AgentSettingProps) {
  const enabled = settings.tabAutoGenerateTitle === true
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentGeneratedTabTitlesTitle()}
        description={getAgentGeneratedTabTitlesDescription()}
        checked={enabled}
        onChange={() => updateSettings({ tabAutoGenerateTitle: !enabled })}
        ariaLabel={getAgentGeneratedTabTitlesTitle()}
      />
    </section>
  )
}
