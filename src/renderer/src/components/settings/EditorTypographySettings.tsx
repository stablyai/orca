import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN,
  TERMINAL_FONT_WEIGHT_STEP
} from '../../../../shared/terminal-fonts'
import { fontFamilyHasKnownLigatures } from '../../../../shared/terminal-ligatures'
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_REGULAR_FONT_WEIGHT,
  resolveEditorFontFamily,
  resolveEditorLigaturesMode,
  type EditorLigaturesMode
} from '@/lib/editor-typography'
import { supportsCodeFontSmoothing, type CodeFontSmoothing } from '@/lib/code-font-smoothing'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { NumberField, SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { getEditorTypographySearchEntries } from './editor-typography-search'

type EditorTypographySettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Opt-in editor overrides; every empty field keeps today's rendering. */
export function EditorTypographySettings({
  settings,
  updateSettings
}: EditorTypographySettingsProps): React.JSX.Element {
  const entries = getEditorTypographySearchEntries()
  const editorFontFamily = resolveEditorFontFamily(settings)
  const ligatures = resolveEditorLigaturesMode(settings)

  return (
    <>
      <SearchableSetting {...entries.fontSize}>
        <NumberField
          label={entries.fontSize.title}
          description={entries.fontSize.description}
          value={settings.editorFontSize}
          min={EDITOR_FONT_SIZE_MIN}
          max={EDITOR_FONT_SIZE_MAX}
          integer
          // Shows the terminal size an empty field follows.
          placeholder={String(settings.terminalFontSize)}
          suffix={translate('auto.components.settings.editorTypography.fontSizeUnit', 'px')}
          onChange={(value) => updateSettings({ editorFontSize: value })}
          onClear={() => updateSettings({ editorFontSize: undefined })}
        />
      </SearchableSetting>

      <SearchableSetting {...entries.fontWeight}>
        <NumberField
          label={entries.fontWeight.title}
          description={entries.fontWeight.description}
          value={settings.editorFontWeight}
          min={TERMINAL_FONT_WEIGHT_MIN}
          max={TERMINAL_FONT_WEIGHT_MAX}
          step={TERMINAL_FONT_WEIGHT_STEP}
          integer
          placeholder={String(EDITOR_REGULAR_FONT_WEIGHT)}
          suffix={`${TERMINAL_FONT_WEIGHT_MIN}-${TERMINAL_FONT_WEIGHT_MAX}`}
          onChange={(value) => updateSettings({ editorFontWeight: value })}
          onClear={() => updateSettings({ editorFontWeight: undefined })}
        />
      </SearchableSetting>

      <SearchableSetting {...entries.lineHeight}>
        <NumberField
          label={entries.lineHeight.title}
          description={entries.lineHeight.description}
          value={settings.editorLineHeight}
          min={0}
          step={0.1}
          clearOnZero
          placeholder={translate(
            'auto.components.settings.editorTypography.lineHeightAuto',
            'Auto'
          )}
          onChange={(value) => updateSettings({ editorLineHeight: value })}
          onClear={() => updateSettings({ editorLineHeight: undefined })}
        />
      </SearchableSetting>

      <SearchableSetting {...entries.ligatures}>
        <SettingsRow
          label={entries.ligatures.title}
          description={
            ligatures === 'auto'
              ? fontFamilyHasKnownLigatures(editorFontFamily)
                ? translate(
                    'auto.components.settings.editorTypography.ligaturesAutoEnabled',
                    'Auto - enabled for "{{value0}}".',
                    { value0: editorFontFamily }
                  )
                : translate(
                    'auto.components.settings.editorTypography.ligaturesAutoDisabled',
                    'Auto - disabled for "{{value0}}".',
                    { value0: editorFontFamily }
                  )
              : entries.ligatures.description
          }
          control={
            <SettingsSegmentedControl<EditorLigaturesMode>
              ariaLabel={entries.ligatures.title}
              value={ligatures}
              onChange={(option) => updateSettings({ editorLigatures: option })}
              options={[
                {
                  value: 'off',
                  label: translate('auto.components.settings.editorTypography.ligaturesOff', 'Off')
                },
                {
                  value: 'auto',
                  label: translate(
                    'auto.components.settings.editorTypography.ligaturesAuto',
                    'Auto'
                  )
                },
                {
                  value: 'on',
                  label: translate('auto.components.settings.editorTypography.ligaturesOn', 'On')
                }
              ]}
            />
          }
        />
      </SearchableSetting>

      {supportsCodeFontSmoothing() ? (
        <SearchableSetting {...entries.fontSmoothing}>
          <SettingsRow
            label={entries.fontSmoothing.title}
            description={entries.fontSmoothing.description}
            control={
              <SettingsSegmentedControl<CodeFontSmoothing>
                ariaLabel={entries.fontSmoothing.title}
                value={settings.codeFontSmoothing === 'native' ? 'native' : 'grayscale'}
                onChange={(option) => updateSettings({ codeFontSmoothing: option })}
                options={[
                  {
                    value: 'grayscale',
                    label: translate(
                      'auto.components.settings.editorTypography.fontSmoothingGrayscale',
                      'Grayscale'
                    )
                  },
                  {
                    value: 'native',
                    label: translate(
                      'auto.components.settings.editorTypography.fontSmoothingNative',
                      'Native'
                    )
                  }
                ]}
              />
            }
          />
        </SearchableSetting>
      ) : null}
    </>
  )
}
