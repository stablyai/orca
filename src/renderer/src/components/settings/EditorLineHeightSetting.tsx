import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  EDITOR_LINE_HEIGHT_AUTO,
  EDITOR_LINE_HEIGHT_MAX,
  EDITOR_LINE_HEIGHT_MIN,
  EDITOR_LINE_HEIGHT_STEP,
  monacoAutomaticLineHeightRatio,
  normalizeEditorLineHeight
} from '@/lib/editor-font-zoom'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { NumberField } from './SettingsFormControls'

type EditorLineHeightSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorLineHeightSetting({
  settings,
  updateSettings
}: EditorLineHeightSettingProps): React.JSX.Element {
  const lineHeight = normalizeEditorLineHeight(settings.editorLineHeight)

  // Why undefined when automatic: NumberField documents undefined as the empty state
  // that pairs with `placeholder` and `onClear`, and an empty row is what tells the
  // user Monaco is still picking the spacing rather than this setting.
  const value = lineHeight === EDITOR_LINE_HEIGHT_AUTO ? undefined : lineHeight

  // Why show Monaco's own ratio: "automatic" is 1.5 on macOS and 1.35 elsewhere, so
  // the greyed number is the only way to know what the editor is spacing at today.
  const automaticRatio = monacoAutomaticLineHeightRatio()

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorLineHeightSetting.title',
        'Editor Line Height'
      )}
      description={translate(
        'auto.components.settings.EditorLineHeightSetting.description',
        'Line spacing in file editors, as a multiple of the font size. Leave empty to keep the editor default.'
      )}
      keywords={['editor', 'line height', 'spacing', 'typography', 'code', 'leading']}
    >
      <NumberField
        label={translate(
          'auto.components.settings.EditorLineHeightSetting.title',
          'Editor Line Height'
        )}
        description={translate(
          'auto.components.settings.EditorLineHeightSetting.description',
          'Line spacing in file editors, as a multiple of the font size. Leave empty to keep the editor default.'
        )}
        value={value}
        min={EDITOR_LINE_HEIGHT_MIN}
        max={EDITOR_LINE_HEIGHT_MAX}
        step={EDITOR_LINE_HEIGHT_STEP}
        suffix="1-3"
        placeholder={String(automaticRatio)}
        onChange={(next) => updateSettings({ editorLineHeight: normalizeEditorLineHeight(next) })}
        onClear={() => updateSettings({ editorLineHeight: EDITOR_LINE_HEIGHT_AUTO })}
      />
    </SearchableSetting>
  )
}
