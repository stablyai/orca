import { Info } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
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
import {
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { getAgentsPaneSearchEntries } from './agents-search'
import {
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue
} from './agent-availability-settings'
import { AgentAvailabilityControl } from './AgentCatalogRow'
import { AgentLaunchSettingsSection } from './AgentLaunchSettingsSection'

export {
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue,
  getAgentsPaneSearchEntries,
  AgentAvailabilityControl
}

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

export function AgentPermissionsSetting({
  mode,
  onChange
}: {
  mode: AgentPermissionMode
  onChange: (mode: Exclude<AgentPermissionMode, 'mixed'>) => void
}): React.JSX.Element {
  const visibleMode: Exclude<AgentPermissionMode, 'mixed'> = mode === 'manual' ? 'manual' : 'yolo'
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={
          <span className="flex items-center gap-2">
            {translate('auto.components.settings.AgentsPane.agentPermissions', 'Agent Permissions')}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={translate(
                    'auto.components.settings.AgentsPane.agentPermissionsInfo',
                    'Agent permissions info'
                  )}
                  className="grid size-5 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.settings.AgentsPane.agentPermissionsTooltip',
                  "Doesn't apply to agents where you've overridden launch arguments."
                )}
              </TooltipContent>
            </Tooltip>
          </span>
        }
        description={translate(
          'auto.components.settings.AgentsPane.agentPermissionsDescription',
          'Choose whether Orca launches agents with fewer permission prompts or with manual checks.'
        )}
        action={
          <SettingsSegmentedControl<AgentPermissionMode>
            value={visibleMode}
            onChange={(nextMode) => {
              if (nextMode !== 'mixed') {
                onChange(nextMode)
              }
            }}
            ariaLabel={translate(
              'auto.components.settings.AgentsPane.agentPermissions',
              'Agent Permissions'
            )}
            size="sm"
            options={[
              {
                value: 'yolo',
                label: translate('auto.components.settings.AgentsPane.agentPermissionsYolo', 'Yolo')
              },
              {
                value: 'manual',
                label: translate(
                  'auto.components.settings.AgentsPane.agentPermissionsManual',
                  'Manual'
                )
              }
            ]}
          />
        }
      />
    </section>
  )
}

export function AgentsPane({
  settings,
  updateSettings,
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

function renderAgentPermissions(
  mode: AgentPermissionMode,
  onChange: (mode: Exclude<AgentPermissionMode, 'mixed'>) => void
): React.ReactNode {
  return <AgentPermissionsSetting mode={mode} onChange={onChange} />
}

export function AgentStatusHooksSetting({ settings, updateSettings }: AgentsPaneProps) {
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

export function AgentWorkspaceTrustSetting({ settings, updateSettings }: AgentsPaneProps) {
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

export function AgentGeneratedTabTitlesSetting({ settings, updateSettings }: AgentsPaneProps) {
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
