import { useAppStore } from '@/store/index'
import {
  getClaudeSubagentNavigationTitle,
  getClaudeSubagentNavigationDescription
} from './behavior/claude-subagent-navigation-copy'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translateLocalExecutionHostLabel } from '../../sidebar/execution-host-label'
import { AgentAwakeSetting } from './behavior/AgentAwakeSetting'
import { AgentCacheTimerSection } from './behavior/AgentCacheTimerSection'
import { AgentRuntimeSetting } from './runtime/AgentRuntimeSetting'
import { CodexTerminalServerIsolationSetting } from './runtime/CodexTerminalServerIsolationSetting'
import { CodexHistorySharingSetting } from './behavior/CodexHistorySharingSetting'
import {
  getAgentGeneratedTabTitlesDescription,
  getAgentGeneratedTabTitlesTitle
} from './behavior/agent-generated-tab-title-copy'
import {
  getClaudeSessionNameSyncDescription,
  getClaudeSessionNameSyncTitle
} from './behavior/claude-session-name-sync-copy'
import {
  getAgentStatusHooksDescription,
  getAgentStatusHooksTitle
} from './behavior/agent-status-hooks-copy'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { AgentLaunchSettingsSection } from './launch/AgentLaunchSettingsSection'
import {
  AgentPermissionsSetting,
  type AgentPermissionsSettingProps
} from './permissions/AgentPermissionsSetting'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import { AgentWorkspaceTrustSetting } from './behavior/AgentWorkspaceTrustSetting'

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
  const t = useTranslate()
  return (
    <div className="space-y-8">
      <AgentLaunchSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        hostScope={hostScope}
        renderPermissions={renderAgentPermissions}
      />
      <SettingsGroup>
        <CodexHistorySharingSetting
          settings={settings}
          updateSettings={updateSettings}
          hostScope={hostScope}
        />
      </SettingsGroup>
      <SettingsGroup title={translateLocalExecutionHostLabel()}>
        <AgentRuntimeSetting
          settings={settings}
          updateSettings={updateSettings}
          refresh={() =>
            useAppStore.getState().refreshDetectedAgents(undefined, { wakeWslDistro: true })
          }
          wslSupportedPlatform={wslSupportedPlatform}
          wslAvailable={wslAvailable}
          wslDistros={wslDistros}
          wslCapabilitiesLoading={wslCapabilitiesLoading}
        />
        <AgentStatusHooksSetting settings={settings} updateSettings={updateSettings} />
        <SettingsSwitchRow
          label={getClaudeSubagentNavigationTitle(t)}
          description={getClaudeSubagentNavigationDescription(t)}
          checked={settings.claudeSubagentNavigationEnabled !== false}
          onChange={() =>
            updateSettings({
              claudeSubagentNavigationEnabled: settings.claudeSubagentNavigationEnabled === false
            })
          }
          ariaLabel={getClaudeSubagentNavigationTitle(t)}
        />
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
        <ClaudeSessionNameSyncSetting settings={settings} updateSettings={updateSettings} />
        {!isPairedWebClientWindow() ? (
          <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />
        ) : null}
      </SettingsGroup>
      <AgentCacheTimerSection settings={settings} updateSettings={updateSettings} />
    </div>
  )
}

function renderAgentPermissions(props: AgentPermissionsSettingProps): React.ReactNode {
  return <AgentPermissionsSetting {...props} />
}

function AgentStatusHooksSetting({ settings, updateSettings }: AgentSettingProps) {
  const t = useTranslate()
  const enabled = settings.agentStatusHooksEnabled !== false
  return (
    <SettingsSwitchRow
      label={getAgentStatusHooksTitle(t)}
      description={getAgentStatusHooksDescription(t)}
      checked={enabled}
      onChange={() => updateSettings({ agentStatusHooksEnabled: !enabled })}
      ariaLabel={getAgentStatusHooksTitle(t)}
    />
  )
}

function AgentGeneratedTabTitlesSetting({ settings, updateSettings }: AgentSettingProps) {
  const t = useTranslate()
  const enabled = settings.tabAutoGenerateTitle === true
  return (
    <SettingsSwitchRow
      label={getAgentGeneratedTabTitlesTitle(t)}
      description={getAgentGeneratedTabTitlesDescription(t)}
      checked={enabled}
      onChange={() => updateSettings({ tabAutoGenerateTitle: !enabled })}
      ariaLabel={getAgentGeneratedTabTitlesTitle(t)}
    />
  )
}

export function ClaudeSessionNameSyncSetting({ settings, updateSettings }: AgentSettingProps) {
  const enabled = settings.claudeSessionNameSync !== false
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getClaudeSessionNameSyncTitle()}
        description={getClaudeSessionNameSyncDescription()}
        checked={enabled}
        onChange={() => updateSettings({ claudeSessionNameSync: !enabled })}
        ariaLabel={getClaudeSessionNameSyncTitle()}
      />
    </section>
  )
}
