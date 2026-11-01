import { useState } from 'react'
import {
  NATIVE_CHAT_FONT_WEIGHTS,
  type NativeChatAppearanceSettings
} from '../../../../shared/native-chat/native-chat-appearance-settings'
import { Slider } from '../ui/slider'
import { SearchableSetting } from './SearchableSetting'
import { SettingsDisabledControlTooltip } from './SettingsDisabledControlTooltip'
import { SettingsRow } from './SettingsFormControls'
import {
  chatTerminalControlledHint,
  chatTerminalControlledTooltip,
  getChatAppearanceEntriesByKey,
  getChatTextWeightLabel
} from './chat-appearance-search'

export function AppearanceChatTextWeightControl({
  appearance,
  onChange,
  forceVisiblePrimary
}: {
  appearance: Required<NativeChatAppearanceSettings>
  onChange: (updates: NativeChatAppearanceSettings) => void
  forceVisiblePrimary?: boolean
}): React.JSX.Element {
  const entry = getChatAppearanceEntriesByKey().textWeight
  const { fontWeight, matchTerminalInterface: matching } = appearance
  const [draft, setDraft] = useState({ savedWeight: fontWeight, value: fontWeight })
  // Keep keyboard focus on the thumb when settings change.
  if (draft.savedWeight !== fontWeight) {
    setDraft({ savedWeight: fontWeight, value: fontWeight })
  }
  return (
    <SearchableSetting id={entry.targetSectionId} {...entry} forceVisible={forceVisiblePrimary}>
      <SettingsRow
        label={entry.title}
        description={matching ? chatTerminalControlledHint() : entry.description}
        control={
          <SettingsDisabledControlTooltip
            reason={matching ? chatTerminalControlledTooltip() : undefined}
          >
            <div className="w-56 space-y-2">
              <Slider
                min={300}
                max={500}
                step={100}
                disabled={matching}
                value={[matching ? 400 : draft.value]}
                thumbLabels={[entry.title]}
                thumbValueLabels={[getChatTextWeightLabel(matching ? 400 : draft.value)]}
                onValueChange={([value]) => setDraft({ savedWeight: fontWeight, value })}
                onValueCommit={([value]) => onChange({ fontWeight: value })}
              />
              <div className="flex justify-between text-xs text-muted-foreground" aria-hidden>
                {NATIVE_CHAT_FONT_WEIGHTS.map((weight) => (
                  <span key={weight}>{getChatTextWeightLabel(weight)}</span>
                ))}
              </div>
            </div>
          </SettingsDisabledControlTooltip>
        }
      />
    </SearchableSetting>
  )
}
