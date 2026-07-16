import type { GlobalSettings } from '../../../../shared/types'
import { isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
import { translate } from '@/i18n/i18n'
import { getBrowserCopyShortcutLabel } from './browser-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type BrowserAutoGrabSettingProps = {
  settings: Pick<GlobalSettings, 'browserAutoGrabEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserAutoGrabSetting({
  settings,
  updateSettings
}: BrowserAutoGrabSettingProps): React.JSX.Element {
  // Why: label the copy chord for the current platform (⌘C on Mac, Ctrl+C else).
  const copyShortcut = getBrowserCopyShortcutLabel({ isMac: isMacUserAgent() })
  const title = translate('auto.components.settings.BrowserAutoGrabSetting.title', 'Auto Grab')
  const description = translate(
    'auto.components.settings.BrowserAutoGrabSetting.description',
    "Grab a page element's context for agents with {{value0}} or the crosshair button in the browser toolbar. Off by default — the browser works like a normal web browser, and {{value0}} copies. Turn this on to enable grabbing.",
    { value0: copyShortcut }
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['browser', 'grab', 'auto grab', 'cmd+c', 'ctrl+c', 'copy', 'element', 'capture']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={settings.browserAutoGrabEnabled === true}
        onChange={() =>
          updateSettings({
            browserAutoGrabEnabled: settings.browserAutoGrabEnabled !== true
          })
        }
      />
    </SearchableSetting>
  )
}
