import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'

type ServerBrowserMemorySectionProps = {
  settings: Pick<GlobalSettings, 'serveBrowserPaintMode' | 'serveBrowserIdleSleepSeconds'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
  showPaintMode: boolean
  showIdleSleep: boolean
}

const IDLE_SLEEP_OPTIONS = [
  { value: 300, label: '5m' },
  { value: 600, label: '10m' },
  { value: 1800, label: '30m' },
  { value: 0, label: 'Never' }
] as const

export function ServerBrowserMemorySection({
  settings,
  updateSettings,
  showPaintMode,
  showIdleSleep
}: ServerBrowserMemorySectionProps): React.JSX.Element | null {
  if (!showPaintMode && !showIdleSleep) {
    return null
  }

  const heading = translate('settings.browser.serverMemory.heading', 'Server browser memory')

  return (
    <div className="space-y-1">
      <SettingsSubsectionHeader
        className="pt-2"
        title={heading}
        description={translate(
          'settings.browser.serverMemory.headingDescription',
          'Applies to headless browser tabs that `orca serve` opens. Does not affect tabs in this app.'
        )}
      />
      {showPaintMode ? (
        <SettingsRow
          label={translate('settings.browser.serverMemory.paintTitle', 'Server tab rendering')}
          description={translate(
            'settings.browser.serverMemory.paintDescription',
            'Auto keeps server tabs invisible until first shown; Always render paints them immediately so first view is instant.'
          )}
          control={
            <SettingsSegmentedControl
              size="sm"
              ariaLabel={translate(
                'settings.browser.serverMemory.paintTitle',
                'Server tab rendering'
              )}
              value={settings.serveBrowserPaintMode ?? 'auto'}
              onChange={(value) => updateSettings({ serveBrowserPaintMode: value })}
              options={[
                {
                  value: 'auto',
                  ariaLabel: translate(
                    'settings.browser.serverMemory.paintOptionAuto',
                    'Auto (recommended)'
                  ),
                  label: translate(
                    'settings.browser.serverMemory.paintOptionAuto',
                    'Auto (recommended)'
                  )
                },
                {
                  value: 'always',
                  ariaLabel: translate(
                    'settings.browser.serverMemory.paintOptionAlways',
                    'Always render'
                  ),
                  label: translate(
                    'settings.browser.serverMemory.paintOptionAlways',
                    'Always render'
                  )
                }
              ]}
            />
          }
        />
      ) : null}
      {showIdleSleep ? (
        <SettingsRow
          label={translate(
            'settings.browser.serverMemory.idleSleepTitle',
            'Sleep idle server browser tabs'
          )}
          description={translate(
            'settings.browser.serverMemory.idleSleepDescription',
            'Tabs with no activity for this long are put to sleep to free memory on the server.'
          )}
          control={
            <SettingsSegmentedControl<number>
              size="sm"
              ariaLabel={translate(
                'settings.browser.serverMemory.idleSleepTitle',
                'Sleep idle server browser tabs'
              )}
              value={settings.serveBrowserIdleSleepSeconds ?? 600}
              onChange={(value) => updateSettings({ serveBrowserIdleSleepSeconds: value })}
              options={IDLE_SLEEP_OPTIONS.map((option) => ({
                value: option.value,
                ariaLabel:
                  option.label === 'Never'
                    ? translate('settings.browser.serverMemory.idleSleepOptionNever', 'Never')
                    : option.label,
                label:
                  option.label === 'Never'
                    ? translate('settings.browser.serverMemory.idleSleepOptionNever', 'Never')
                    : option.label
              }))}
            />
          }
        />
      ) : null}
    </div>
  )
}
