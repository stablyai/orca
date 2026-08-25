import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getTerminalLinkActionSearchKeywords,
  getTerminalLinkActionsDescription,
  getTerminalLinkActionsTitle
} from './terminal-link-actions-copy'

type TerminalLinkActionsSettingProps = {
  settings: Pick<GlobalSettings, 'terminalLinkActionPopoverEnabled'>
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalLinkActionsSetting({
  settings,
  isMac,
  updateSettings
}: TerminalLinkActionsSettingProps): React.JSX.Element {
  const title = getTerminalLinkActionsTitle()
  const description = getTerminalLinkActionsDescription({ isMac })

  return (
    <SearchableSetting
      id={TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={getTerminalLinkActionSearchKeywords({ isMac })}
    >
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
    </SearchableSetting>
  )
}
