import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AndroidLogo, IosBrandIcon } from '../mobile/MobileBrandIcons'
import { MobileEmulatorAgentControlRow } from './MobileEmulatorAgentControlRow'
import { MobileEmulatorAvailabilityDetails } from './MobileEmulatorAvailabilityDetails'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'
import { getMobileEmulatorSearchEntries } from './mobile-emulator-search'
import { translate } from '@/i18n/i18n'

type SimulatorDeviceRow = {
  name: string
  udid: string
  state: string
  runtime?: string
  isAvailable?: boolean
}

type EmulatorAvailability = {
  platform: string
  available: boolean
  devices: SimulatorDeviceRow[]
  simctl: { ok: boolean; message?: string }
  serveSim: { ok: boolean; message?: string }
  android: { sdkFound: boolean; sdkPath?: string; message: string }
  message: string
}

type MobileEmulatorSettingsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const AUTOMATIC_DEVICE_VALUE = '__orca_automatic_emulator_device__'
const AUTOMATIC_DEVICE_LABEL = 'Auto-select device'
const SIMULATOR_STATE_SUFFIX_RE =
  /\s+\((Booted|Booting|Creating|Shutdown|Shutting Down|Unavailable|Unknown)\)\s*$/i

function statusText(availability: EmulatorAvailability | null, enabled: boolean): string {
  if (!enabled) {
    return translate('auto.components.settings.MobileEmulatorSettingsPane.a4f1c82d90', 'Disabled')
  }
  if (!availability) {
    return translate(
      'auto.components.settings.MobileEmulatorSettingsPane.b5e2d93e01',
      'Checking...'
    )
  }
  return availability.available
    ? translate('auto.components.settings.MobileEmulatorSettingsPane.c6f3ea4f12', 'Ready')
    : translate('auto.components.settings.MobileEmulatorSettingsPane.d704fb5023', 'Needs setup')
}

function statusBadgeClassName(availability: EmulatorAvailability | null, enabled: boolean): string {
  if (!enabled) {
    return 'border-border/50 bg-muted/30 text-muted-foreground'
  }
  if (!availability) {
    return 'border-border/50 bg-muted/30 text-muted-foreground'
  }
  return availability.available
    ? 'border-status-success-border bg-status-success-background text-status-success'
    : 'border-destructive/30 bg-destructive/10 text-destructive'
}

function deviceLabel(device: SimulatorDeviceRow): string {
  const state = device.state.trim()
  const name = device.name.replace(SIMULATOR_STATE_SUFFIX_RE, '').trim()
  if (device.isAvailable === false) {
    return `${name} (Unavailable)`
  }
  if (!state || state.toLowerCase() === 'shutdown') {
    return name
  }
  return `${name} (${state})`
}

function isAndroidDevice(device: SimulatorDeviceRow): boolean {
  return device.runtime === 'Android'
}

function DeviceSelectItemLabel({ device }: { device: SimulatorDeviceRow }): React.JSX.Element {
  const Icon = isAndroidDevice(device) ? AndroidLogo : IosBrandIcon
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className="size-3.5 shrink-0 fill-current text-muted-foreground" />
      <span className="truncate">{deviceLabel(device)}</span>
    </span>
  )
}

function availabilityDetail(availability: EmulatorAvailability | null): string {
  if (!availability) {
    return translate(
      'auto.components.settings.MobileEmulatorSettingsPane.06b06429c6',
      'Checking Android SDK and iOS Simulator support.'
    )
  }
  if (availability.available) {
    return availability.devices.length === 1
      ? translate(
          'auto.components.settings.MobileEmulatorSettingsPane.6d1483d4a0',
          '1 emulator device detected.'
        )
      : translate(
          'auto.components.settings.MobileEmulatorSettingsPane.0a452d4d3b',
          '{{value0}} emulator devices detected.',
          { value0: availability.devices.length }
        )
  }
  return availability.simctl.message || availability.serveSim.message || availability.message
}

export function MobileEmulatorSettingsPane({
  settings,
  updateSettings
}: MobileEmulatorSettingsPaneProps): React.JSX.Element {
  const [availability, setAvailability] = useState<EmulatorAvailability | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const enabled = settings.mobileEmulatorEnabled !== false

  const refreshAvailability = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      const result = (await callRuntimeRpc(
        { kind: 'local' },
        'emulator.availability',
        {}
      )) as EmulatorAvailability
      setAvailability(result)
    } catch (error) {
      setAvailability({
        platform: '',
        available: false,
        devices: [],
        simctl: { ok: false },
        serveSim: { ok: false },
        android: { sdkFound: false, message: '' },
        message: error instanceof Error ? error.message : 'Could not check emulator availability.'
      })
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refreshAvailability()
  }, [refreshAvailability])

  const devices = availability?.devices ?? []
  const selectedDeviceKnown = devices.some(
    (device) => device.udid === settings.mobileEmulatorDefaultDeviceUdid
  )
  const selectValue =
    settings.mobileEmulatorDefaultDeviceUdid && selectedDeviceKnown
      ? settings.mobileEmulatorDefaultDeviceUdid
      : AUTOMATIC_DEVICE_VALUE

  const defaultDeviceDescription = useMemo(() => {
    if (devices.length === 0) {
      return translate(
        'auto.components.settings.MobileEmulatorSettingsPane.f62a1bb759',
        'Orca will auto-select an emulator device after devices are detected.'
      )
    }
    return translate(
      'auto.components.settings.MobileEmulatorSettingsPane.b2fd62ea75',
      'Default device for new emulator tabs and agent attach commands. Auto-select prefers an already running device.'
    )
  }, [devices.length])

  return (
    <div className="space-y-4">
      <SearchableSetting
        title={translate(
          'auto.components.settings.MobileEmulatorSettingsPane.6593c9ddd3',
          'Mobile Emulator'
        )}
        description={translate(
          'auto.components.settings.MobileEmulatorSettingsPane.bc39d0f115',
          'Configure mobile emulator support for Orca and coding agents.'
        )}
        keywords={getMobileEmulatorSearchEntries().flatMap((entry) => entry.keywords ?? [])}
        className="divide-y divide-border/40"
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.700ddbf9b1',
            'Enable Mobile Emulator'
          )}
          description={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.f9af91ea26',
            'Shows the New Mobile Emulator action and allows agents to attach to the active emulator.'
          )}
          checked={enabled}
          onChange={() => updateSettings({ mobileEmulatorEnabled: !enabled })}
        />

        <div className="py-2">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.MobileEmulatorSettingsPane.ae1612c58c',
                  'Availability'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">{availabilityDetail(availability)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge
                variant="outline"
                className={cn('text-[11px]', statusBadgeClassName(availability, enabled))}
              >
                {refreshing ? <Loader2 className="size-3 animate-spin" /> : null}
                {statusText(availability, enabled)}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.settings.MobileEmulatorSettingsPane.8aec2f99a0',
                  'Refresh emulator availability'
                )}
                onClick={() => void refreshAvailability()}
                disabled={refreshing}
              >
                {refreshing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </Button>
            </div>
          </div>

          {enabled ? (
            <MobileEmulatorAvailabilityDetails
              availability={availability}
              configuredPath={settings.androidSdkPath ?? null}
              onSetAndroidSdkPath={async (path) => {
                await updateSettings({ androidSdkPath: path })
                await refreshAvailability()
              }}
            />
          ) : null}
        </div>

        <SettingsRow
          alignTop
          label={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.143961d031',
            'Default Device'
          )}
          description={defaultDeviceDescription}
          control={
            <Select
              value={selectValue}
              disabled={!enabled}
              onValueChange={(value) =>
                updateSettings({
                  mobileEmulatorDefaultDeviceUdid: value === AUTOMATIC_DEVICE_VALUE ? null : value
                })
              }
            >
              <SelectTrigger size="sm" className="w-56 max-w-full">
                <SelectValue placeholder={AUTOMATIC_DEVICE_LABEL} />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={AUTOMATIC_DEVICE_VALUE}>{AUTOMATIC_DEVICE_LABEL}</SelectItem>
                {devices.map((device) => (
                  <SelectItem
                    key={device.udid}
                    value={device.udid}
                    textValue={deviceLabel(device)}
                    disabled={device.isAvailable === false}
                  >
                    <DeviceSelectItemLabel device={device} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SearchableSetting>

      {enabled ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.f2f8d97bb6',
            'Agent Mobile Emulator Control'
          )}
          description={translate(
            'auto.components.settings.MobileEmulatorSettingsPane.19d39113b6',
            'Let coding agents control the active mobile emulator with Orca CLI commands.'
          )}
          keywords={getMobileEmulatorSearchEntries()[3]?.keywords}
        >
          <MobileEmulatorAgentControlRow />
        </SearchableSetting>
      ) : null}
    </div>
  )
}
