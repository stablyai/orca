import type { GlobalSettings } from '../../../../shared/types'
import type { GlobalWindowsRuntimeDefault } from '../../../../shared/project-execution-runtime'
import { normalizeGlobalWindowsRuntimeDefault } from '../../../../shared/project-execution-runtime'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type DefaultRuntimeSegment = GlobalWindowsRuntimeDefault['kind']

type DefaultWindowsProjectRuntimeSettingProps = {
  settings: Pick<GlobalSettings, 'localWindowsRuntimeDefault'>
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<unknown>
  wslSupportedPlatform: boolean
  wslAvailable: boolean
  wslDistros: string[]
  wslCapabilitiesLoading: boolean
}

const NO_DISTRO_VALUE = '__select_wsl_distro__'

export function DefaultWindowsProjectRuntimeSetting({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading
}: DefaultWindowsProjectRuntimeSettingProps): React.JSX.Element | null {
  if (!wslSupportedPlatform) {
    return null
  }

  const defaultRuntime = normalizeGlobalWindowsRuntimeDefault(settings.localWindowsRuntimeDefault)
  const nextWslDistro = getNextDefaultWslDistro(defaultRuntime, wslDistros)
  const distroOptions = getVisibleDistroOptions(defaultRuntime, wslDistros)
  const handleRuntimeChange = (value: DefaultRuntimeSegment): void => {
    if (value === 'windows-host') {
      void updateSettings({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
      return
    }
    if (nextWslDistro) {
      void updateSettings({
        localWindowsRuntimeDefault: { kind: 'wsl', distro: nextWslDistro }
      })
    }
  }

  return (
    <section className="space-y-3">
      <SettingsRow
        label={translate(
          'auto.components.settings.DefaultWindowsProjectRuntimeSetting.defaultRuntime',
          'Default project runtime'
        )}
        alignTop
        description={getDefaultRuntimeDescription(
          defaultRuntime,
          wslAvailable,
          wslCapabilitiesLoading
        )}
        control={
          <div className="flex w-52 flex-col items-stretch gap-2">
            <SettingsSegmentedControl<DefaultRuntimeSegment>
              ariaLabel={translate(
                'auto.components.settings.DefaultWindowsProjectRuntimeSetting.defaultRuntime',
                'Default project runtime'
              )}
              value={defaultRuntime.kind}
              onChange={handleRuntimeChange}
              equalWidth
              options={[
                {
                  value: 'windows-host',
                  label: translate(
                    'auto.components.settings.DefaultWindowsProjectRuntimeSetting.windows',
                    'Windows'
                  )
                },
                {
                  value: 'wsl',
                  label: translate(
                    'auto.components.settings.DefaultWindowsProjectRuntimeSetting.wsl',
                    'WSL'
                  ),
                  disabled: wslCapabilitiesLoading || !wslAvailable || !nextWslDistro
                }
              ]}
            />
            {defaultRuntime.kind === 'wsl' ? (
              <Select
                value={defaultRuntime.distro ?? NO_DISTRO_VALUE}
                onValueChange={(distro) => {
                  if (distro !== NO_DISTRO_VALUE) {
                    void updateSettings({
                      localWindowsRuntimeDefault: { kind: 'wsl', distro }
                    })
                  }
                }}
                disabled={wslCapabilitiesLoading || !wslAvailable}
              >
                <SelectTrigger size="sm" className="w-full min-w-52">
                  <SelectValue
                    placeholder={translate(
                      'auto.components.settings.DefaultWindowsProjectRuntimeSetting.selectDistro',
                      'Select distro'
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {!defaultRuntime.distro ? (
                    <SelectItem value={NO_DISTRO_VALUE}>
                      {translate(
                        'auto.components.settings.DefaultWindowsProjectRuntimeSetting.selectDistro',
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
    </section>
  )
}

function getNextDefaultWslDistro(
  defaultRuntime: GlobalWindowsRuntimeDefault,
  wslDistros: readonly string[]
): string | null {
  if (defaultRuntime.kind === 'wsl' && defaultRuntime.distro?.trim()) {
    return defaultRuntime.distro.trim()
  }
  return wslDistros.find((distro) => distro.trim().length > 0) ?? null
}

function getVisibleDistroOptions(
  defaultRuntime: GlobalWindowsRuntimeDefault,
  wslDistros: readonly string[]
): string[] {
  const options = [...wslDistros]
  if (
    defaultRuntime.kind === 'wsl' &&
    defaultRuntime.distro &&
    !options.includes(defaultRuntime.distro)
  ) {
    return [defaultRuntime.distro, ...options]
  }
  return options
}

function getDefaultRuntimeDescription(
  defaultRuntime: GlobalWindowsRuntimeDefault,
  wslAvailable: boolean,
  wslCapabilitiesLoading: boolean
): string {
  if (defaultRuntime.kind === 'windows-host') {
    return translate(
      'auto.components.settings.DefaultWindowsProjectRuntimeSetting.windowsDescription',
      'Projects inherit Windows unless a project overrides it.'
    )
  }
  if (!wslAvailable && !wslCapabilitiesLoading) {
    return translate(
      'auto.components.settings.DefaultWindowsProjectRuntimeSetting.wslUnavailable',
      'WSL is not available. Projects that inherit WSL will need repair.'
    )
  }
  if (!defaultRuntime.distro) {
    return translate(
      'auto.components.settings.DefaultWindowsProjectRuntimeSetting.distroRequired',
      'Choose a WSL distro before projects can inherit WSL.'
    )
  }
  return translate(
    'auto.components.settings.DefaultWindowsProjectRuntimeSetting.wslDescription',
    'Projects inherit {{value0}} via WSL unless a project overrides it.',
    { value0: defaultRuntime.distro }
  )
}
