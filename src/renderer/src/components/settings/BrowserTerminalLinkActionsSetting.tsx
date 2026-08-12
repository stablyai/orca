import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getTerminalLinkActionsDescription } from './browser-link-routing-copy'
import { getTerminalLinkActionSearchKeywords } from './browser-search'

type BrowserTerminalLinkActionsSettingProps = {
  settings: Pick<GlobalSettings, 'terminalLinkActionPopoverEnabled'>
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserTerminalLinkActionsSetting({
  settings,
  isMac,
  updateSettings
}: BrowserTerminalLinkActionsSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.title',
    'Show terminal link actions'
  )
  const description = getTerminalLinkActionsDescription({ isMac })

  return (
    <SearchableSetting
      id={BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={getTerminalLinkActionSearchKeywords({ isMac })}
    >
      <div className="ml-4 border-l border-border pl-4">
        <SettingsSwitchRow
          label={title}
          description={description}
          checked={settings.terminalLinkActionPopoverEnabled !== false}
          onChange={() =>
            updateSettings({
              terminalLinkActionPopoverEnabled: settings.terminalLinkActionPopoverEnabled === false
            })
          }
        />
      </div>
    </SearchableSetting>
  )
}
