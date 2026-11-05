import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { NumberField } from '../form-controls/SettingsFormControls'
import {
  DEFAULT_SINGLE_PANE_MAX_WIDTH,
  MIN_SINGLE_PANE_WIDTH
} from '../../terminal-pane/TerminalSinglePaneWidthHandles'
import { getSinglePaneWidthEntries } from './appearance-single-pane-width-search'

export function SinglePaneWidthSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getSinglePaneWidthEntries()[0]
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <NumberField
        label={entry.title}
        description=""
        value={settings.terminalSinglePaneMaxWidth ?? DEFAULT_SINGLE_PANE_MAX_WIDTH}
        defaultValue={DEFAULT_SINGLE_PANE_MAX_WIDTH}
        min={0}
        max={4000}
        step={10}
        suffix="px"
        onChange={(value) =>
          updateSettings({
            // Below the drag floor the first drag would silently snap the value
            // back up, so refuse the width the drag cannot hold.
            terminalSinglePaneMaxWidth: value <= 0 ? 0 : Math.max(MIN_SINGLE_PANE_WIDTH, value)
          })
        }
      />
    </SearchableSetting>
  )
}
