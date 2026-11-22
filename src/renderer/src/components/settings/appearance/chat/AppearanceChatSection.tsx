import {
  DEFAULT_NATIVE_CHAT_FONT_SIZE,
  normalizeNativeChatAppearanceSettings,
  resetNativeChatAppearanceSettings,
  resolveNativeChatAppearanceSettings,
  type NativeChatAppearanceSettings
} from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { useAppStore } from '../../../../store/index'
import { formatPrimaryShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { AppearanceChatContrastControls } from './AppearanceChatContrastControls'
import {
  AppearanceChatBackgroundControls,
  deleteNativeChatBackground
} from './AppearanceChatBackgroundControls'
import { ChatFontFamilySetting } from './ChatFontFamilySetting'
import { Button } from '../../../ui/button'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from '../../form-controls/SettingsFormControls'
import {
  chatTerminalControlledHint,
  chatTerminalControlledTooltip,
  getChatAppearanceEntriesByKey,
  getChatWidthOptions
} from './chat-appearance-search'
import { writeNativeChatAppearance } from '../../../native-chat/appearance/native-chat-appearance-write'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'

export type AppearanceChatSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisiblePrimary?: boolean
  showDesktopOnlySettings?: boolean
  fontSuggestions?: string[]
  onRequestFontSuggestions?: () => void
}

export function AppearanceChatSection({
  settings,
  updateSettings,
  fontSuggestions,
  onRequestFontSuggestions,
  forceVisiblePrimary = false,
  showDesktopOnlySettings = true
}: AppearanceChatSectionProps): React.JSX.Element {
  const t = useTranslate()
  const appearance = resolveNativeChatAppearanceSettings(settings.nativeChatAppearance)
  const matching = appearance.matchTerminalInterface
  const keybindings = useAppStore((state) => state.keybindings)
  const increase = formatPrimaryShortcutLabel('zoom.in', keybindings)
  const decrease = formatPrimaryShortcutLabel('zoom.out', keybindings)
  const entries = getChatAppearanceEntriesByKey({ increase, decrease }, t)
  const updateSettingsOrThrow = useAppStore((state) => state.updateSettingsOrThrow)
  const update = (updates: NativeChatAppearanceSettings): Promise<boolean> =>
    writeNativeChatAppearance(
      (current) => normalizeNativeChatAppearanceSettings({ ...current, ...updates }),
      updateSettings
    )
  return (
    <>
      <AppearanceChatContrastControls
        appearance={appearance}
        onChange={update}
        forceVisiblePrimary={forceVisiblePrimary}
      />
      <AppearanceChatBackgroundControls
        appearance={appearance}
        onChange={update}
        showImageControls={showDesktopOnlySettings}
        forceVisiblePrimary={forceVisiblePrimary}
      />
      <ChatFontFamilySetting
        settings={settings}
        onChange={(fontFamily) => void update({ fontFamily })}
        fontSuggestions={fontSuggestions}
        onRequestFontSuggestions={onRequestFontSuggestions}
        forceVisible={forceVisiblePrimary}
      />
      <SearchableSetting
        id={entries.textSize.targetSectionId}
        {...entries.textSize}
        forceVisible={forceVisiblePrimary}
      >
        <NumberField
          label={entries.textSize.title}
          description={matching ? chatTerminalControlledHint(t) : entries.textSize.description}
          value={appearance.fontSize}
          defaultValue={matching ? undefined : DEFAULT_NATIVE_CHAT_FONT_SIZE}
          disabled={matching}
          disabledReason={chatTerminalControlledTooltip(t)}
          min={12}
          max={20}
          integer
          suffix={t('settings.appearance.chat.pixels', 'px')}
          onChange={(fontSize) => void update({ fontSize })}
        />
      </SearchableSetting>
      <SearchableSetting
        id={entries.codeTextSize.targetSectionId}
        {...entries.codeTextSize}
        forceVisible={forceVisiblePrimary}
      >
        <NumberField
          label={entries.codeTextSize.title}
          description={matching ? chatTerminalControlledHint(t) : entries.codeTextSize.description}
          value={appearance.codeFontSize}
          defaultValue={matching ? undefined : 12}
          disabled={matching}
          disabledReason={chatTerminalControlledTooltip(t)}
          min={10}
          max={18}
          integer
          suffix={t('settings.appearance.chat.pixels', 'px')}
          onChange={(codeFontSize) => void update({ codeFontSize })}
        />
      </SearchableSetting>
      <SearchableSetting
        id={entries.width.targetSectionId}
        {...entries.width}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={entries.width.title}
          description={entries.width.description}
          control={
            <SettingsSegmentedControl
              value={appearance.width}
              onChange={(width) => void update({ width })}
              options={getChatWidthOptions(t)}
              ariaLabel={entries.width.title}
            />
          }
        />
      </SearchableSetting>
      <SearchableSetting
        id={entries.reset.targetSectionId}
        {...entries.reset}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={entries.reset.title}
          description={entries.reset.description}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void resetChatAppearance(updateSettingsOrThrow)}
            >
              {t('settings.appearance.chat.reset', 'Reset')}
            </Button>
          }
        />
      </SearchableSetting>
    </>
  )
}

/** Deletes the reset picture's file only once the reset is saved. */
async function resetChatAppearance(
  persist: (updates: Partial<GlobalSettings>) => Promise<void>
): Promise<void> {
  let picture: string | undefined
  const saved = await writeNativeChatAppearance((current) => {
    picture = current?.backgroundImage
    return resetNativeChatAppearanceSettings(current)
  }, persist)
  if (saved) {
    deleteNativeChatBackground(picture)
  }
}
