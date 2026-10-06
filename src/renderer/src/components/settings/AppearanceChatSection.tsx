import {
  normalizeNativeChatAppearanceSettings,
  resetNativeChatAppearanceSettings,
  resolveNativeChatAppearanceSettings,
  type NativeChatAppearanceSettings
} from '../../../../shared/native-chat-appearance-settings'
import { useAppStore } from '../../store'
import { formatPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { AppearanceChatContrastControls } from './AppearanceChatContrastControls'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { NumberField, SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import {
  chatTerminalControlledHint,
  chatTerminalControlledTooltip,
  getChatAppearanceEntriesByKey,
  getChatWidthOptions
} from './chat-appearance-search'
import { writeNativeChatAppearance } from '../native-chat/native-chat-appearance-write'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

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
  const matching = appearance.matchTerminalInterface
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
      <AppearanceChatContrastControls
        appearance={appearance}
        onChange={update}
        forceVisiblePrimary={forceVisiblePrimary}
      />
      <SearchableSetting
        id={entries.textSize.targetSectionId}
        {...entries.textSize}
        forceVisible={forceVisiblePrimary}
      >
        <NumberField
          label={entries.textSize.title}
          description={matching ? chatTerminalControlledHint() : entries.textSize.description}
          value={appearance.fontSize}
          defaultValue={matching ? undefined : 14}
          disabled={matching}
          disabledReason={chatTerminalControlledTooltip()}
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
          description={matching ? chatTerminalControlledHint() : entries.codeTextSize.description}
          value={appearance.codeFontSize}
          defaultValue={matching ? undefined : 12}
          disabled={matching}
          disabledReason={chatTerminalControlledTooltip()}
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
