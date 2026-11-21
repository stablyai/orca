import { useId } from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { formatKeybindingList } from '../../../../../shared/keybindings/formatting'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'

type NativeChatSendKeySettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  title: string
  description: string
}

export function NativeChatSendKeySetting({
  settings,
  updateSettings,
  title,
  description
}: NativeChatSendKeySettingProps): React.JSX.Element {
  const labelId = useId()
  const platform = getShortcutPlatform()
  return (
    <SettingsRow
      label={title}
      description={description}
      labelId={labelId}
      control={
        <Select
          value={settings.nativeChatSendKey === 'shift-enter' ? 'shift-enter' : 'enter'}
          onValueChange={(value) => {
            if (value === 'enter' || value === 'shift-enter') {
              updateSettings({ nativeChatSendKey: value })
            }
          }}
        >
          <SelectTrigger size="sm" className="min-w-32" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="enter">{formatKeybindingList(['Enter'], platform)}</SelectItem>
            <SelectItem value="shift-enter">
              {formatKeybindingList(['Shift+Enter'], platform)}
            </SelectItem>
          </SelectContent>
        </Select>
      }
    />
  )
}
