import type { GlobalSettings } from '../../../../shared/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'

type AgentDetectionRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  label: string
}

type AgentLocationSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  refresh: () => Promise<unknown>
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

function getHostRuntimeLabel(): string {
  return navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'
}

function getSelectedAgentRuntime(
  settings: GlobalSettings,
  wslAvailable: boolean,
  wslDistros: string[],
  wslCapabilitiesLoading: boolean
): AgentDetectionRuntime {
  const configuredRuntime =
    settings.localAgentRuntime ?? (settings.terminalWindowsShell === 'wsl.exe' ? 'wsl' : 'host')
  if (configuredRuntime === 'wsl') {
    if (!wslAvailable && !wslCapabilitiesLoading) {
      return { runtime: 'wsl', label: 'WSL' }
    }
    const configuredDistro =
      settings.localAgentWslDistro?.trim() || settings.terminalWindowsWslDistro?.trim() || null
    const selectedDistro =
      configuredDistro && (wslCapabilitiesLoading || wslDistros.includes(configuredDistro))
        ? configuredDistro
        : null
    return {
      runtime: 'wsl',
      wslDistro: selectedDistro,
      label: selectedDistro ? `WSL ${selectedDistro}` : 'WSL default'
    }
  }
  return { runtime: 'host', label: getHostRuntimeLabel() }
}

export function AgentLocationSetting({
  settings,
  updateSettings,
  refresh,
  wslAvailable = false,
  wslDistros = [],
  wslCapabilitiesLoading = false
}: AgentLocationSettingProps): React.JSX.Element {
  const agentRuntime = getSelectedAgentRuntime(
    settings,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading
  )
  const updateAgentLocation = (updates: Partial<GlobalSettings>): void => {
    void Promise.resolve(updateSettings(updates)).then(() => refresh())
  }

  return (
    <section className="space-y-3">
      <SettingsRow
        label="Agent location"
        alignTop
        description={
          agentRuntime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading
            ? 'WSL is not available on this machine.'
            : `Show installed agents from ${agentRuntime.label}. Refresh re-checks PATH in that environment.`
        }
        control={
          <div className="flex w-44 flex-col items-stretch gap-2">
            <SettingsSegmentedControl
              ariaLabel="Agent location"
              value={agentRuntime.runtime}
              onChange={(value) => updateAgentLocation({ localAgentRuntime: value })}
              equalWidth
              options={[
                { value: 'host', label: getHostRuntimeLabel() },
                {
                  value: 'wsl',
                  label: 'WSL',
                  disabled: wslCapabilitiesLoading || !wslAvailable
                }
              ]}
            />
            {agentRuntime.runtime === 'wsl' ? (
              <Select
                value={agentRuntime.wslDistro ?? '__default__'}
                onValueChange={(value) =>
                  updateAgentLocation({
                    localAgentRuntime: 'wsl',
                    localAgentWslDistro: value === '__default__' ? null : value
                  })
                }
                disabled={wslCapabilitiesLoading || !wslAvailable}
              >
                <SelectTrigger size="sm" className="w-full min-w-44">
                  <SelectValue
                    placeholder={wslCapabilitiesLoading ? 'Loading WSL' : 'WSL default'}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">WSL default</SelectItem>
                  {wslDistros.map((distro) => (
                    <SelectItem key={distro} value={distro}>
                      {distro}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        }
      />
    </section>
  )
}
