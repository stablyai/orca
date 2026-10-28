import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { translate } from '@/i18n/i18n'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/**
 * Why a control and not just the OS signal: Electron reports Chromium's accessibility-support flag
 * on macOS and Windows only, so `Auto` alone leaves Linux users no way in; and on macOS the flag
 * goes true for any accessibility client, not only screen readers, so someone running an unrelated
 * utility needs a way out.
 */
export function TerminalScreenReaderSetting({
  settings,
  updateSettings
}: Props): React.JSX.Element {
  const mode = settings.terminalScreenReaderMode ?? 'auto'
  const detectsAssistiveClients = getRendererAppPlatform() !== 'linux'
  const title = translate('auto.components.settings.screenReader.title', 'Screen Reader Support')
  const description = translate(
    'auto.components.settings.screenReader.description',
    'Keep a text copy of the visible rows so screen readers can read terminal output. Panes are drawn to a canvas, which exposes no text on its own.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'terminal',
        'accessibility',
        'a11y',
        'screen reader',
        'screenreader',
        'voiceover',
        'narrator',
        'nvda',
        'jaws',
        'blind',
        'assistive'
      ]}
    >
      <SettingsRow
        label={title}
        description={
          mode === 'on'
            ? translate(
                'auto.components.settings.screenReader.on',
                'Always on. Rows stay readable even when the system reports no assistive client.'
              )
            : mode === 'off'
              ? translate(
                  'auto.components.settings.screenReader.off',
                  'Always off. No row text is kept, even while a screen reader is running.'
                )
              : detectsAssistiveClients
                ? translate(
                    'auto.components.settings.screenReader.autoDetected',
                    'Auto - on while the system reports an assistive client, off otherwise.'
                  )
                : translate(
                    'auto.components.settings.screenReader.autoUndetected',
                    'Auto - this platform does not report assistive clients, so Auto stays off. Choose On to keep rows readable.'
                  )
        }
        control={
          <SettingsSegmentedControl
            ariaLabel={title}
            value={mode}
            onChange={(option) => updateSettings({ terminalScreenReaderMode: option })}
            options={[
              {
                value: 'auto',
                label: translate('auto.components.settings.screenReader.auto', 'Auto')
              },
              {
                value: 'on',
                label: translate('auto.components.settings.screenReader.modeOn', 'On')
              },
              {
                value: 'off',
                label: translate('auto.components.settings.screenReader.modeOff', 'Off')
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
