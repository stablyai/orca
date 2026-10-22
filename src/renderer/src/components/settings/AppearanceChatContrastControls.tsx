import { useState } from 'react'
import type { NativeChatAppearanceSettings } from '../../../../shared/native-chat-appearance-settings'
import {
  chatTerminalControlledHint,
  chatTerminalControlledTooltip,
  getChatContrastEntriesByKey
} from './chat-appearance-search'
import { translate } from '@/i18n/i18n'
import { Slider } from '../ui/slider'
import { SearchableSetting } from './SearchableSetting'
import { SettingsDisabledControlTooltip } from './SettingsDisabledControlTooltip'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'

type ChatContrastControlsProps = {
  appearance: Required<NativeChatAppearanceSettings>
  onChange: (updates: NativeChatAppearanceSettings) => void
  forceVisiblePrimary?: boolean
}

export function AppearanceChatContrastControls({
  appearance,
  onChange,
  forceVisiblePrimary
}: ChatContrastControlsProps): React.JSX.Element {
  const entries = getChatContrastEntriesByKey()
  const { contrast, matchTerminalInterface: matching } = appearance
  return (
    <>
      <SearchableSetting
        id={entries.matchTerminalInterface.targetSectionId}
        {...entries.matchTerminalInterface}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsSwitchRow
          label={entries.matchTerminalInterface.title}
          description={entries.matchTerminalInterface.description}
          checked={matching}
          onChange={() => onChange({ matchTerminalInterface: !matching })}
        />
      </SearchableSetting>
      <SearchableSetting
        id={entries.contrast.targetSectionId}
        {...entries.contrast}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={entries.contrast.title}
          description={matching ? chatTerminalControlledHint() : entries.contrast.description}
          control={
            <ChatContrastSlider contrast={contrast} onChange={onChange} disabled={matching} />
          }
        />
      </SearchableSetting>
    </>
  )
}

function ChatContrastSlider({
  contrast,
  onChange,
  disabled
}: Pick<ChatContrastControlsProps, 'onChange'> & {
  contrast: number
  disabled: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState({ savedContrast: contrast, value: contrast })
  // Keep the thumb mounted so committed keyboard changes retain focus.
  if (draft.savedContrast !== contrast) {
    setDraft({ savedContrast: contrast, value: contrast })
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {translate('settings.appearance.chat.softer', 'Softer')}
      </span>
      <SettingsDisabledControlTooltip
        reason={disabled ? chatTerminalControlledTooltip() : undefined}
      >
        <div className="w-40">
          <Slider
            disabled={disabled}
            min={50}
            max={150}
            step={1}
            value={[draft.value]}
            thumbLabels={[translate('settings.appearance.chat.contrast', 'Contrast')]}
            onValueChange={([value]) => setDraft({ savedContrast: contrast, value })}
            onValueCommit={([value]) => onChange({ contrast: value })}
          />
        </div>
      </SettingsDisabledControlTooltip>
      <span className="text-xs text-muted-foreground">
        {translate('settings.appearance.chat.sharper', 'Sharper')}
      </span>
      <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">
        {draft.value}
      </span>
    </div>
  )
}
