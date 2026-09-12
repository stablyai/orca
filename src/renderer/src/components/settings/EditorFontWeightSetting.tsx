import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN,
  TERMINAL_FONT_WEIGHT_STEP,
  normalizeTerminalFontWeight
} from '../../../../shared/terminal-fonts'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { NumberField } from './SettingsFormControls'

type EditorFontWeightSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorFontWeightSetting({
  settings,
  updateSettings
}: EditorFontWeightSettingProps): React.JSX.Element {
  const editorFontWeight = settings.editorFontWeight

  // Why NaN when unset: NumberField renders an empty input — and therefore the
  // "same as terminal" placeholder — for a non-finite value, which is what tells
  // the user the editor is still inheriting rather than pinned to its own weight.
  const value =
    typeof editorFontWeight === 'number' && editorFontWeight > 0
      ? normalizeTerminalFontWeight(editorFontWeight)
      : Number.NaN

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorFontWeightSetting.title',
        'Editor Font Weight'
      )}
      description={translate(
        'auto.components.settings.EditorFontWeightSetting.description',
        'Weight used by file editors and diff views. Leave empty to follow the terminal font weight.'
      )}
      keywords={['editor', 'font', 'typography', 'weight', 'code', 'bold', 'thin']}
    >
      <NumberField
        label={translate(
          'auto.components.settings.EditorFontWeightSetting.title',
          'Editor Font Weight'
        )}
        description={translate(
          'auto.components.settings.EditorFontWeightSetting.description',
          'Weight used by file editors and diff views. Leave empty to follow the terminal font weight.'
        )}
        value={value}
        min={TERMINAL_FONT_WEIGHT_MIN}
        max={TERMINAL_FONT_WEIGHT_MAX}
        step={TERMINAL_FONT_WEIGHT_STEP}
        integer
        suffix="100-900"
        placeholder={translate(
          'auto.components.settings.EditorFontWeightSetting.placeholder',
          'Same as terminal font weight'
        )}
        onChange={(next) => updateSettings({ editorFontWeight: normalizeTerminalFontWeight(next) })}
        onClear={() => updateSettings({ editorFontWeight: 0 })}
      />
    </SearchableSetting>
  )
}
