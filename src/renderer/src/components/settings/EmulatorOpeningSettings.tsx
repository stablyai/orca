import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getEmulatorOpeningMode } from '../../../../shared/emulator-opening-preferences'
import { SettingsRow } from './SettingsFormControls'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

type Device = { name: string; udid: string; runtime?: string; isAvailable?: boolean }
type Props = {
  settings: GlobalSettings
  devices: Device[]
  enabled: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}
export function EmulatorOpeningSettings({ settings, devices, enabled, updateSettings }: Props) {
  const mode = getEmulatorOpeningMode(settings)
  const fixed = settings.mobileEmulatorDefaultDeviceUdid ?? ''
  const missing = fixed && !devices.some((device) => device.udid === fixed)
  return (
    <>
      <SettingsRow
        alignTop
        label={translate('emulator.opening.when', 'When opening')}
        description={translate(
          'emulator.opening.description',
          'Applies to new emulator tabs on this computer. Existing workspace sessions stay connected.'
        )}
        control={
          <Select
            value={mode}
            disabled={!enabled}
            onValueChange={(value) => {
              if (value === 'last-used' || value === 'ask' || value === 'specific') {
                void updateSettings({ mobileEmulatorOpeningMode: value })
              }
            }}
          >
            <SelectTrigger size="sm" className="w-56 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="last-used">
                {translate('emulator.opening.lastUsed', 'Last used')}
              </SelectItem>
              <SelectItem value="ask">
                {translate('emulator.opening.ask', 'Ask every time')}
              </SelectItem>
              <SelectItem value="specific">
                {translate('emulator.opening.specific', 'Specific device')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {mode === 'specific' && (
        <SettingsRow
          alignTop
          label={translate('emulator.opening.fixed', 'Default device')}
          description={translate(
            'emulator.opening.fixedDescription',
            'Choose an existing device. A missing or unavailable device prompts for another selection instead of starting a different platform.'
          )}
          control={
            <Select
              value={fixed}
              disabled={!enabled}
              onValueChange={(value) =>
                void updateSettings({ mobileEmulatorDefaultDeviceUdid: value })
              }
            >
              <SelectTrigger size="sm" className="w-56 max-w-full">
                <SelectValue placeholder={translate('emulator.opening.choose', 'Choose device')}>
                  {devices.find((device) => device.udid === fixed)?.name || fixed || undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {missing && (
                  <SelectItem value={fixed} disabled>
                    {fixed} · {translate('emulator.opening.notFound', 'Not found')}
                  </SelectItem>
                )}
                {devices.map((device) => (
                  <SelectItem
                    key={device.udid}
                    value={device.udid}
                    disabled={device.isAvailable === false}
                    textValue={device.name}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{device.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {device.runtime
                          ?.replace('com.apple.CoreSimulator.SimRuntime.', '')
                          .replaceAll('-', '.')}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      )}
    </>
  )
}
