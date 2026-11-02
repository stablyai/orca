import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { cn } from '@/lib/utils'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { EmulatorOpeningSettings } from './EmulatorOpeningSettings'
import { MobileEmulatorAgentControlRow } from './MobileEmulatorAgentControlRow'
import { MobileEmulatorAvailabilityDetails } from './MobileEmulatorAvailabilityDetails'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getMobileEmulatorSearchEntries } from './mobile-emulator-search'
import { translate } from '@/i18n/i18n'
import { emulatorErrorText, emulatorMessageText } from '@/lib/emulator-error-copy'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

type SimulatorDeviceRow = {
  name: string
  udid: string
  state: string
  runtime?: string
  isAvailable?: boolean
}

type CodedMessage = { message?: string; messageCode?: unknown; messageParams?: unknown }

type EmulatorAvailability = CodedMessage & {
  platform: string
  available: boolean
  devices: SimulatorDeviceRow[]
  simctl: { ok: boolean } & CodedMessage
  serveSim: { ok: boolean } & CodedMessage
  android: { sdkFound: boolean; sdkPath?: string } & CodedMessage
}

type MobileEmulatorSettingsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}

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
  const source = [availability.simctl, availability.serveSim].find((check) => check.message)
  return emulatorMessageText(source ?? availability)
}

export function MobileEmulatorSettingsPane({
  settings,
  updateSettings
}: MobileEmulatorSettingsPaneProps): React.JSX.Element {
  useUiLanguageRevision()
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
        message: emulatorErrorText(
          error,
          translate(
            'emulator.settings.availabilityCheckFailed',
            'Could not check emulator availability.'
          )
        )
      })
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refreshAvailability()
  }, [refreshAvailability])

  const devices = availability?.devices ?? []
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

        <EmulatorOpeningSettings
          settings={settings}
          devices={devices}
          enabled={enabled}
          updateSettings={updateSettings}
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
