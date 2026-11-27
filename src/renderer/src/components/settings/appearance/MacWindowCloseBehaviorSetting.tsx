import type { ReactElement } from 'react'
import {
  normalizeMacWindowCloseBehavior,
  type MacWindowCloseBehavior
} from '../../../../../shared/app-lifecycle/windows/macos-window-close-behavior'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { getMacWindowCloseBehaviorEntry } from './appearance-system-presence-search'

export function MacWindowCloseBehaviorSetting({
  value,
  onChange
}: {
  value: MacWindowCloseBehavior | undefined
  onChange: (value: MacWindowCloseBehavior) => void
}): ReactElement {
  const t = useTranslate()
  const entry = getMacWindowCloseBehaviorEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
    >
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <Select
            value={normalizeMacWindowCloseBehavior(value)}
            onValueChange={(next) => onChange(normalizeMacWindowCloseBehavior(next))}
          >
            <SelectTrigger size="sm" aria-label={entry.title}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="close-window">
                {t('settings.appearance.macWindowCloseBehavior.closeWindow', 'Close window')}
              </SelectItem>
              <SelectItem value="hide-to-menu-bar">
                {t('settings.appearance.macWindowCloseBehavior.hideToMenuBar', 'Hide to menu bar')}
              </SelectItem>
              <SelectItem value="quit-app">
                {t('settings.appearance.macWindowCloseBehavior.quitApp', 'Quit Orca')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
