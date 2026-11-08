import type { GlobalSettings } from '../../../../../../shared/global-settings-types'

import {
  type GlobalWindowsRuntimeDefault,
  normalizeGlobalWindowsRuntimeDefault
} from '../../../../../../shared/execution-host/project-runtime-preference'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SettingsRow, SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type AgentRuntimeSegment = GlobalWindowsRuntimeDefault['kind']

type AgentRuntimeSettingProps = {
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'>
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<unknown>
  refresh: () => Promise<unknown>
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

const EMPTY_WSL_DISTROS: string[] = []
const NO_DISTRO_VALUE = '__select_wsl_distro__'

function getHostRuntimeLabel(): string {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
    ? 'Windows'
    : 'This device'
}

export function AgentRuntimeSetting({
  settings,
  updateSettings,
  refresh,
  wslSupportedPlatform = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false
}: AgentRuntimeSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  if (!wslSupportedPlatform) {
    return null
  }

  const runtimeDefault = normalizeGlobalWindowsRuntimeDefault(settings.localWindowsRuntimeDefault)
  const nextWslDistro = getNextWslDistro(runtimeDefault, wslDistros)
  const distroOptions = getVisibleDistroOptions(runtimeDefault, wslDistros)
  const updateAgentRuntime = (updates: Partial<GlobalSettings>): void => {
    void Promise.resolve(updateSettings(updates)).then(() => refresh())
  }
  const handleRuntimeChange = (value: AgentRuntimeSegment): void => {
    if (value === 'windows-host') {
      updateAgentRuntime({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
      return
    }
    if (nextWslDistro) {
      updateAgentRuntime({
        localWindowsRuntimeDefault: { kind: 'wsl', distro: nextWslDistro }
      })
    }
  }

  return (
    <SettingsRow
      label={t('auto.components.settings.AgentRuntimeSetting.label', 'Agent runtime')}
      alignTop
      description={getDescription(runtimeDefault, wslAvailable, wslCapabilitiesLoading, t)}
      control={
        <div className="flex w-52 flex-col items-stretch gap-2">
          <SettingsSegmentedControl<AgentRuntimeSegment>
            ariaLabel={t('auto.components.settings.AgentRuntimeSetting.label', 'Agent runtime')}
            value={runtimeDefault.kind}
            onChange={handleRuntimeChange}
            equalWidth
            options={[
              {
                value: 'windows-host',
                label: getHostRuntimeLabel()
              },
              {
                value: 'wsl',
                label: t('auto.components.settings.AgentRuntimeSetting.wsl', 'WSL'),
                disabled: wslCapabilitiesLoading || !wslAvailable || !nextWslDistro
              }
            ]}
          />
          {runtimeDefault.kind === 'wsl' ? (
            <Select
              value={runtimeDefault.distro ?? NO_DISTRO_VALUE}
              onValueChange={(distro) => {
                if (distro !== NO_DISTRO_VALUE) {
                  updateAgentRuntime({
                    localWindowsRuntimeDefault: { kind: 'wsl', distro }
                  })
                }
              }}
              disabled={wslCapabilitiesLoading || !wslAvailable}
            >
              <SelectTrigger size="sm" className="w-full min-w-52">
                <SelectValue
                  placeholder={
                    wslCapabilitiesLoading
                      ? t('auto.components.settings.AgentRuntimeSetting.loadingWsl', 'Loading WSL')
                      : t(
                          'auto.components.settings.AgentRuntimeSetting.selectDistro',
                          'Select distro'
                        )
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {!runtimeDefault.distro ? (
                  <SelectItem value={NO_DISTRO_VALUE}>
                    {t(
                      'auto.components.settings.AgentRuntimeSetting.selectDistro',
                      'Select distro'
                    )}
                  </SelectItem>
                ) : null}
                {distroOptions.map((distro) => (
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
  )
}

function getNextWslDistro(
  runtimeDefault: GlobalWindowsRuntimeDefault,
  wslDistros: readonly string[]
): string | null {
  if (runtimeDefault.kind === 'wsl' && runtimeDefault.distro?.trim()) {
    return runtimeDefault.distro.trim()
  }
  return wslDistros.find((distro) => distro.trim().length > 0) ?? null
}

function getVisibleDistroOptions(
  runtimeDefault: GlobalWindowsRuntimeDefault,
  wslDistros: readonly string[]
): string[] {
  const options = [...wslDistros]
  if (
    runtimeDefault.kind === 'wsl' &&
    runtimeDefault.distro &&
    !options.includes(runtimeDefault.distro)
  ) {
    return [runtimeDefault.distro, ...options]
  }
  return options
}

function getDescription(
  runtimeDefault: GlobalWindowsRuntimeDefault,
  wslAvailable: boolean,
  wslCapabilitiesLoading: boolean,
  t: Translate = translate
): string {
  if (runtimeDefault.kind === 'windows-host') {
    return t(
      'auto.components.settings.AgentRuntimeSetting.windowsDescription',
      'Detect and launch agents on Windows for projects that do not override their runtime.'
    )
  }
  if (!wslAvailable && !wslCapabilitiesLoading) {
    return t(
      'auto.components.settings.AgentRuntimeSetting.wslUnavailable',
      'WSL is not available on this machine.'
    )
  }
  if (!runtimeDefault.distro) {
    return t(
      'auto.components.settings.AgentRuntimeSetting.distroRequired',
      'Choose a WSL distro before projects can inherit WSL.'
    )
  }
  return t(
    'auto.components.settings.AgentRuntimeSetting.wslDescription',
    'Detect and launch agents in {{value0}} via WSL for projects that do not override their runtime.',
    { value0: runtimeDefault.distro }
  )
}
