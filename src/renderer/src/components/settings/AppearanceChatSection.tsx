import {
  NATIVE_CHAT_COLOR_KEYS,
  normalizeNativeChatAppearanceSettings,
  type NativeChatColorKey,
  resetNativeChatAppearanceSettings,
  resolveNativeChatAppearanceSettings,
  type NativeChatAppearanceSettings
} from '../../../../shared/native-chat-appearance-settings'
import { useAppStore } from '../../store'
import { formatPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import {
  ColorField,
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from './SettingsFormControls'
import { getChatAppearanceEntriesByKey, getChatWidthOptions } from './chat-appearance-search'
import { writeNativeChatAppearance } from '../native-chat/native-chat-appearance-write'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Why: approximate the themes' chat colors so a picker opens near the current color.
const CHAT_COLOR_PICKER_START: Record<NativeChatColorKey, string> = {
  textColorLight: '#363636',
  textColorDark: '#c8c8c8',
  userBubbleColorLight: '#f5f5f5',
  userBubbleColorDark: '#262626'
}

export type AppearanceChatSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisiblePrimary?: boolean
}

export function AppearanceChatSection({
  settings,
  updateSettings,
  forceVisiblePrimary = false
}: AppearanceChatSectionProps): React.JSX.Element {
  const appearance = resolveNativeChatAppearanceSettings(settings.nativeChatAppearance)
  const keybindings = useAppStore((state) => state.keybindings)
  const increase = formatPrimaryShortcutLabel('zoom.in', keybindings)
  const decrease = formatPrimaryShortcutLabel('zoom.out', keybindings)
  const entries = getChatAppearanceEntriesByKey({ increase, decrease })
  const update = (updates: NativeChatAppearanceSettings): void => {
    void writeNativeChatAppearance(
      (current) => normalizeNativeChatAppearanceSettings({ ...current, ...updates }),
      updateSettings
    )
  }
  return (
    <div className="divide-y divide-border/40">
      <SearchableSetting
        id={entries.textSize.targetSectionId}
        {...entries.textSize}
        forceVisible={forceVisiblePrimary}
      >
        <NumberField
          label={entries.textSize.title}
          description={entries.textSize.description}
          value={appearance.fontSize}
          defaultValue={14}
          min={12}
          max={20}
          integer
          suffix={translate('settings.appearance.chat.pixels', 'px')}
          onChange={(fontSize) => update({ fontSize })}
        />
      </SearchableSetting>
      <SearchableSetting
        id={entries.codeTextSize.targetSectionId}
        {...entries.codeTextSize}
        forceVisible={forceVisiblePrimary}
      >
        <NumberField
          label={entries.codeTextSize.title}
          description={entries.codeTextSize.description}
          value={appearance.codeFontSize}
          defaultValue={12}
          min={10}
          max={18}
          integer
          suffix={translate('settings.appearance.chat.pixels', 'px')}
          onChange={(codeFontSize) => update({ codeFontSize })}
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
              onChange={(width) => update({ width })}
              options={getChatWidthOptions()}
              ariaLabel={entries.width.title}
            />
          }
        />
      </SearchableSetting>
      {NATIVE_CHAT_COLOR_KEYS.map((key) => (
        <SearchableSetting
          key={key}
          id={entries[key].targetSectionId}
          {...entries[key]}
          forceVisible={forceVisiblePrimary}
        >
          <ColorField
            label={entries[key].title}
            description={entries[key].description}
            value={settings.nativeChatAppearance?.[key] ?? ''}
            fallback={CHAT_COLOR_PICKER_START[key]}
            onChange={(color) => update({ [key]: color })}
          />
        </SearchableSetting>
      ))}
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
              onClick={() =>
                void writeNativeChatAppearance(resetNativeChatAppearanceSettings, updateSettings)
              }
            >
              {translate('settings.appearance.chat.reset', 'Reset')}
            </Button>
          }
        />
      </SearchableSetting>
    </div>
  )
}
