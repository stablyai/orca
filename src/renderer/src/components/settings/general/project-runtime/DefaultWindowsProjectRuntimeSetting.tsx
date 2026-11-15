import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { GlobalWindowsRuntimeDefault } from '../../../../../../shared/execution-host/project-runtime-preference'
import { normalizeGlobalWindowsRuntimeDefault } from '../../../../../../shared/execution-host/project-runtime-preference'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SettingsRow, SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

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
  const t = useTranslate()
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
        label={t(
          'auto.components.settings.DefaultWindowsProjectRuntimeSetting.defaultRuntime',
          'Default project runtime'
        )}
        alignTop
        description={getDefaultRuntimeDescription(
          defaultRuntime,
          wslAvailable,
          wslCapabilitiesLoading,
          t
        )}
        control={
          <div className="flex w-52 flex-col items-stretch gap-2">
            <SettingsSegmentedControl<DefaultRuntimeSegment>
              ariaLabel={t(
                'auto.components.settings.DefaultWindowsProjectRuntimeSetting.defaultRuntime',
                'Default project runtime'
              )}
              value={defaultRuntime.kind}
              onChange={handleRuntimeChange}
              equalWidth
              options={[
                {
                  value: 'windows-host',
                  label: t(
                    'auto.components.settings.DefaultWindowsProjectRuntimeSetting.windows',
                    'Windows'
                  )
                },
                {
                  value: 'wsl',
                  label: t(
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
                    placeholder={t(
                      'auto.components.settings.DefaultWindowsProjectRuntimeSetting.selectDistro',
                      'Select distro'
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {!defaultRuntime.distro ? (
                    <SelectItem value={NO_DISTRO_VALUE}>
                      {t(
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
  wslCapabilitiesLoading: boolean,
  t: Translate = translate
): string {
  if (defaultRuntime.kind === 'windows-host') {
    return t(
      'auto.components.settings.DefaultWindowsProjectRuntimeSetting.windowsDescription',
      'Projects inherit Windows unless a project overrides it.'
    )
  }
  if (!wslAvailable && !wslCapabilitiesLoading) {
    return t(
      'auto.components.settings.DefaultWindowsProjectRuntimeSetting.wslUnavailable',
      'WSL is not available. Projects that inherit WSL will need repair.'
    )
  }
  if (!defaultRuntime.distro) {
    return t(
      'auto.components.settings.DefaultWindowsProjectRuntimeSetting.distroRequired',
      'Choose a WSL distro before projects can inherit WSL.'
    )
  }
  return t(
    'auto.components.settings.DefaultWindowsProjectRuntimeSetting.wslDescription',
    'Projects inherit {{value0}} via WSL unless a project overrides it.',
    { value0: defaultRuntime.distro }
  )
}
