import React from 'react'
import type { ModifierRemap } from '../../../../shared/modifier-remap'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

export function ModifierRemapControl({
  modifierRemap,
  keywords,
  updateSettings
}: {
  modifierRemap: ModifierRemap
  keywords?: string[]
  updateSettings: (updates: { modifierRemap?: ModifierRemap }) => Promise<void> | void
}): React.JSX.Element {
  return (
    <SearchableSetting
      id="modifier-remap"
      title={translate('settings.modifierRemap.title', 'Modifier Keys')}
      description={translate(
        'settings.modifierRemap.description',
        'Swap Ctrl and Command so app shortcuts fire from Ctrl and Command reaches the terminal as a control character. Native menu shortcuts such as ⌘Q stay on Command.'
      )}
      keywords={keywords}
      className="max-w-none"
    >
      <SettingsRow
        label={translate('settings.modifierRemap.rowLabel', 'Ctrl / Command')}
        description={translate(
          'settings.modifierRemap.rowDescription',
          'Applies to every key event, including terminal panes'
        )}
        control={
          <Select
            value={modifierRemap}
            onValueChange={(value) =>
              void updateSettings({ modifierRemap: value as ModifierRemap })
            }
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {translate('settings.modifierRemap.option.none', 'Default')}
              </SelectItem>
              <SelectItem value="swap-ctrl-cmd">
                {translate('settings.modifierRemap.option.swap', 'Swap Ctrl and Command')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
