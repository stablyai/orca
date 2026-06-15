import type { GlobalSettings } from '../../../../shared/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

const EMPTY_WSL_DISTROS: string[] = []

type AgentDetectionRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  label: string
}

type AgentLocationSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  refresh: () => Promise<unknown>
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

function getHostRuntimeLabel(): string {
  return navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'
}

function getSelectedAgentRuntime(
  settings: GlobalSettings,
  wslSupportedPlatform: boolean,
  wslAvailable: boolean,
  wslDistros: string[],
  wslCapabilitiesLoading: boolean
): AgentDetectionRuntime {
  const configuredRuntime =
    settings.localAgentRuntime ?? (settings.terminalWindowsShell === 'wsl.exe' ? 'wsl' : 'host')
  if (wslSupportedPlatform && configuredRuntime === 'wsl') {
    if (!wslAvailable && !wslCapabilitiesLoading) {
      return {
        runtime: 'wsl',
        label: translate('auto.components.settings.AgentLocationSetting.43663b5e69', 'WSL')
      }
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
  wslSupportedPlatform = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false
}: AgentLocationSettingProps): React.JSX.Element | null {
  const agentRuntime = getSelectedAgentRuntime(
    settings,
    wslSupportedPlatform,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading
  )
  const updateAgentLocation = (updates: Partial<GlobalSettings>): void => {
    void Promise.resolve(updateSettings(updates)).then(() => refresh())
  }

  if (!wslSupportedPlatform) {
    return null
  }

  return (
    <section className="space-y-3">
      <SettingsRow
        label={translate(
          'auto.components.settings.AgentLocationSetting.9bccf48906',
          'Agent location'
        )}
        alignTop
        description={
          agentRuntime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading
            ? translate(
                'auto.components.settings.AgentLocationSetting.c7c516946f',
                'WSL is not available on this machine.'
              )
            : translate(
                'auto.components.settings.AgentLocationSetting.d00949e59b',
                'Show installed agents from {{value0}}. Refresh re-checks PATH in that environment.',
                { value0: agentRuntime.label }
              )
        }
        control={
          <div className="flex w-44 flex-col items-stretch gap-2">
            <SettingsSegmentedControl
              ariaLabel={translate(
                'auto.components.settings.AgentLocationSetting.9bccf48906',
                'Agent location'
              )}
              value={agentRuntime.runtime}
              onChange={(value) => updateAgentLocation({ localAgentRuntime: value })}
              equalWidth
              options={[
                { value: 'host', label: getHostRuntimeLabel() },
                ...(wslSupportedPlatform
                  ? [
                      {
                        value: 'wsl',
                        label: translate(
                          'auto.components.settings.AgentLocationSetting.43663b5e69',
                          'WSL'
                        ),
                        disabled: wslCapabilitiesLoading || !wslAvailable
                      } as const
                    ]
                  : [])
              ]}
            />
            {wslSupportedPlatform && agentRuntime.runtime === 'wsl' ? (
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
                    placeholder={
                      wslCapabilitiesLoading
                        ? translate(
                            'auto.components.settings.AgentLocationSetting.fc806485ae',
                            'Loading WSL'
                          )
                        : translate(
                            'auto.components.settings.AgentLocationSetting.92f4238f1a',
                            'WSL default'
                          )
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    {translate(
                      'auto.components.settings.AgentLocationSetting.92f4238f1a',
                      'WSL default'
                    )}
                  </SelectItem>
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
