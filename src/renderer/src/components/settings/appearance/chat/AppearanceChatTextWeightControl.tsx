import { useState } from 'react'
import type { NativeChatAppearanceSettings } from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import {
  DEFAULT_NATIVE_CHAT_FONT_WEIGHT,
  NATIVE_CHAT_FONT_WEIGHTS
} from '../../../../../../shared/native-chat/settings/native-chat-font-weight'
import { useTranslate } from '@/i18n/use-translate'
import { Slider } from '../../../ui/slider'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsDisabledControlTooltip } from '../../form-controls/SettingsDisabledControlTooltip'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
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
  onChange: (updates: NativeChatAppearanceSettings) => Promise<boolean>
  forceVisiblePrimary?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getChatAppearanceEntriesByKey(undefined, t).textWeight
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
        description={matching ? chatTerminalControlledHint(t) : entry.description}
        control={
          <SettingsDisabledControlTooltip
            reason={matching ? chatTerminalControlledTooltip(t) : undefined}
          >
            <div className="w-56 space-y-2">
              <Slider
                min={300}
                max={500}
                step={100}
                disabled={matching}
                value={[matching ? DEFAULT_NATIVE_CHAT_FONT_WEIGHT : draft.value]}
                thumbLabels={[entry.title]}
                thumbValueLabels={[
                  getChatTextWeightLabel(
                    matching ? DEFAULT_NATIVE_CHAT_FONT_WEIGHT : draft.value,
                    t
                  )
                ]}
                onValueChange={([value]) => setDraft({ savedWeight: fontWeight, value })}
                onValueCommit={async ([value]) => {
                  if (!(await onChange({ fontWeight: value }))) {
                    setDraft((current) =>
                      current.savedWeight === fontWeight && current.value === value
                        ? { savedWeight: fontWeight, value: fontWeight }
                        : current
                    )
                  }
                }}
              />
              <div className="flex justify-between text-xs text-muted-foreground" aria-hidden>
                {NATIVE_CHAT_FONT_WEIGHTS.map((weight) => (
                  <span key={weight}>{getChatTextWeightLabel(weight, t)}</span>
                ))}
              </div>
            </div>
          </SettingsDisabledControlTooltip>
        }
      />
    </SearchableSetting>
  )
}
