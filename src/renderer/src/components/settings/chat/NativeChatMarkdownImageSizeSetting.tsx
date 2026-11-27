import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { normalizeNativeChatMarkdownImageSize } from '../../../../../shared/native-chat/settings/native-chat-markdown-image-size'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { matchesSettingsSearch } from '../search/settings-search'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { Label } from '../../ui/label'
import { useAppStore } from '../../../store/index'
import { getChatMarkdownImageSizeSearchEntry } from './chat-markdown-image-size-search'

type NativeChatMarkdownImageSizeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}

export function NativeChatMarkdownImageSizeSetting({
  settings,
  updateSettings,
  forceVisible = false
}: NativeChatMarkdownImageSizeSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const entry = getChatMarkdownImageSizeSearchEntry()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const size = normalizeNativeChatMarkdownImageSize(settings.nativeChatMarkdownImageSize)
  if (!forceVisible && !matchesSettingsSearch(query, [entry])) {
    return null
  }
  return (
    <SettingsGroup>
      <SearchableSetting
        {...entry}
        id="chat-markdown-image-size"
        forceVisible={forceVisible}
        className="max-w-none"
      >
        <div className="space-y-2 py-3">
          <div className="space-y-0.5">
            <Label>{entry.title}</Label>
            <p className="text-xs text-muted-foreground">{entry.description}</p>
          </div>
          <SettingsSegmentedControl
            ariaLabel={entry.title}
            equalWidth
            wrap
            value={size}
            onChange={(option) => updateSettings({ nativeChatMarkdownImageSize: option })}
            options={[
              {
                value: 'compact',
                label: t('components.settings.nativeChat.markdownImageSizeCompact', 'Compact')
              },
              {
                value: 'medium',
                label: t('components.settings.nativeChat.markdownImageSizeMedium', 'Medium')
              },
              {
                value: 'column',
                label: t('components.settings.nativeChat.markdownImageSizeColumn', 'Column width')
              }
            ]}
          />
        </div>
      </SearchableSetting>
    </SettingsGroup>
  )
}
