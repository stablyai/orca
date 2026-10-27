import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveNativeChatAppearanceSettings } from '../../../../shared/native-chat-appearance-settings'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  useNativeChatAppearanceStyle
} from '../native-chat/native-chat-appearance-style'
import { FontAutocomplete, SettingsRow } from './SettingsFormControls'
import { SettingsDisabledControlTooltip } from './SettingsDisabledControlTooltip'
import { SearchableSetting } from './SearchableSetting'
import {
  chatTerminalControlledHint,
  chatTerminalControlledTooltip,
  getChatAppearanceEntriesByKey
} from './chat-appearance-search'

const EMPTY_FONT_SUGGESTIONS: string[] = []

export function ChatFontFamilySetting({
  settings,
  onChange,
  fontSuggestions = EMPTY_FONT_SUGGESTIONS,
  onRequestFontSuggestions,
  forceVisible
}: {
  settings: GlobalSettings
  onChange: (fontFamily: string) => void
  fontSuggestions?: string[]
  onRequestFontSuggestions?: () => void
  forceVisible?: boolean
}): React.JSX.Element {
  const appearance = resolveNativeChatAppearanceSettings(settings.nativeChatAppearance)
  const matching = appearance.matchTerminalInterface
  const [previewFamily, setPreviewFamily] = useState<string | null>(null)
  const entry = getChatAppearanceEntriesByKey().fontFamily
  const style = useNativeChatAppearanceStyle({
    ...settings,
    nativeChatAppearance: {
      ...settings.nativeChatAppearance,
      fontFamily: previewFamily ?? appearance.fontFamily
    }
  })
  const defaultLabel = translate('settings.appearance.chat.inheritFont', 'Same as IDE font')

  return (
    <SearchableSetting id={entry.targetSectionId} {...entry} forceVisible={forceVisible}>
      <SettingsRow
        label={entry.title}
        description={matching ? chatTerminalControlledHint() : entry.description}
        control={
          <SettingsDisabledControlTooltip
            reason={matching ? chatTerminalControlledTooltip() : undefined}
          >
            <FontAutocomplete
              value={appearance.fontFamily}
              ariaLabel={entry.title}
              suggestions={fontSuggestions}
              placeholder={defaultLabel}
              defaultOptionLabel={defaultLabel}
              disabled={matching}
              commitMode="blur"
              onChange={onChange}
              onRequestSuggestions={onRequestFontSuggestions}
              onPreviewFontFamily={setPreviewFamily}
            />
          </SettingsDisabledControlTooltip>
        }
      />
      <p
        aria-label={translate('settings.appearance.chat.fontPreviewLabel', 'Chat font preview')}
        className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} mb-3 rounded-md border border-border px-3 py-2 text-sm text-chat-foreground`}
        style={style}
      >
        {translate(
          'settings.appearance.chat.fontPreview',
          'The quick brown fox jumps over the lazy dog.'
        )}{' '}
        <code className="font-mono text-chat-code">fontFamily</code>
      </p>
    </SearchableSetting>
  )
}
