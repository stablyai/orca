import type React from 'react'
import { useId } from 'react'
import type {
  GlobalSettings,
  NativeChatReferenceChipMode
} from '../../../../../shared/global-settings-types'
import { nativeChatReferenceChipMode } from '../../../../../shared/native-chat/native-chat-reference-chips'
import { useTranslate } from '@/i18n/use-translate'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SettingsRow } from '../form-controls/SettingsFormControls'

const MODES: readonly NativeChatReferenceChipMode[] = ['full', 'compact', 'off']

function isMode(value: string): value is NativeChatReferenceChipMode {
  return MODES.some((mode) => mode === value)
}

export function NativeChatReferenceChipsSetting({
  settings,
  updateSettings,
  title,
  description
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  title: string
  description: string
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  const labels: Record<NativeChatReferenceChipMode, string> = {
    full: t('components.settings.nativeChat.referenceChipsFull', 'Full: ID and title'),
    compact: t('components.settings.nativeChat.referenceChipsCompact', 'Compact: ID only'),
    off: t('components.settings.nativeChat.referenceChipsOff', 'Off: plain links')
  }
  return (
    <SettingsRow
      label={title}
      description={description}
      labelId={labelId}
      control={
        <Select
          value={nativeChatReferenceChipMode(settings)}
          onValueChange={(value) => {
            if (isMode(value)) {
              updateSettings({ nativeChatReferenceChips: value })
            }
          }}
        >
          <SelectTrigger size="sm" className="min-w-40" aria-labelledby={labelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {labels[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  )
}
