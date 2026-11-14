import { GENERAL_SETTING_ANCHORS, generalSetting } from '../general/general-setting-anchors'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

import { isMacUserAgent } from '../../../app-shell/platform/user-agent-platform'
import type { SettingsSearchEntry } from '../search/settings-search'

function editorTypographyKeywords(): string[] {
  return [
    ...translateSearchKeyword('auto.components.settings.general.search.e1ee631696', 'editor'),
    ...translateSearchKeyword('auto.components.settings.general.search.editorFontKw', 'font'),
    ...translateSearchKeyword('auto.components.settings.general.search.3ca5ab78a5', 'code'),
    ...translateSearchKeyword(
      'auto.components.settings.editorTypography.typographyKw',
      'typography'
    )
  ]
}

/** Shared by the rows and the General search index so a match always reveals its row. */
export const getEditorTypographySearchEntries = createLocalizedCatalog(() => ({
  fontSize: {
    title: translate('auto.components.settings.editorTypography.253fc29ebb', 'Editor font size'),
    description: translate(
      'auto.components.settings.editorTypography.fontSizeDesc',
      'Base size for file editors and diff views. Leave empty to follow the terminal font size.'
    ),
    keywords: [
      ...editorTypographyKeywords(),
      ...translateSearchKeyword('auto.components.settings.editorTypography.sizeKw', 'size')
    ]
  },
  fontWeight: {
    title: translate('auto.components.settings.editorTypography.09d72edc6f', 'Editor font weight'),
    description: translate(
      'auto.components.settings.editorTypography.fontWeightDesc',
      'Weight for file editors and diff views. Leave empty for regular weight (400).'
    ),
    keywords: [
      ...editorTypographyKeywords(),
      ...translateSearchKeyword('auto.components.settings.editorTypography.weightKw', 'weight'),
      ...translateSearchKeyword('auto.components.settings.editorTypography.boldKw', 'bold')
    ]
  },
  lineHeight: {
    title: translate('auto.components.settings.editorTypography.8e8a87f9ed', 'Editor line height'),
    description: translate(
      'auto.components.settings.editorTypography.lineHeightDesc',
      'Line spacing as a multiple of the editor font size; values of 8 or more are read as pixels. Leave empty or 0 for automatic spacing.'
    ),
    keywords: [
      ...editorTypographyKeywords(),
      ...translateSearchKeyword(
        'auto.components.settings.editorTypography.lineHeightKw',
        'line height'
      ),
      ...translateSearchKeyword('auto.components.settings.editorTypography.spacingKw', 'spacing')
    ]
  },
  ligatures: {
    title: translate(
      'auto.components.settings.editorTypography.83db4f82b0',
      'Editor font ligatures'
    ),
    description: translate(
      'auto.components.settings.editorTypography.ligaturesDesc',
      'Render ligatures such as => and !== in file editors and diff views.'
    ),
    keywords: [
      ...editorTypographyKeywords(),
      ...translateSearchKeyword(
        'auto.components.settings.editorTypography.ligaturesKw',
        'ligatures'
      ),
      ...translateSearchKeyword('auto.components.settings.editorTypography.ligatureKw', 'ligature'),
      ...translateSearchKeyword(
        'auto.components.settings.editorTypography.fontFeaturesKw',
        'font features'
      )
    ]
  },
  fontSmoothing: {
    title: translate('auto.components.settings.editorTypography.d4b7264499', 'Font smoothing'),
    description: translate(
      'auto.components.settings.editorTypography.fontSmoothingDesc',
      'How terminals and code editors smooth text. Native draws heavier glyphs, closer to other macOS terminals.'
    ),
    keywords: [
      ...editorTypographyKeywords(),
      ...translateSearchKeyword('auto.components.settings.terminal.search.f66a7cf715', 'terminal'),
      ...translateSearchKeyword(
        'auto.components.settings.editorTypography.smoothingKw',
        'smoothing'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.editorTypography.antialiasingKw',
        'antialiasing'
      ),
      ...translateSearchKeyword('auto.components.settings.editorTypography.thinKw', 'thin text')
    ]
  }
}))

/** Font smoothing only exists on macOS, so search must not reveal a row that never renders. */
export function getVisibleEditorTypographySearchEntries(): SettingsSearchEntry[] {
  const { fontSmoothing, ...entries } = getEditorTypographySearchEntries()
  return isMacUserAgent() ? [...Object.values(entries), fontSmoothing] : Object.values(entries)
}

export const getVisibleEditorTypographySearchDescriptors = createLocalizedCatalog(() => {
  const entries = getEditorTypographySearchEntries()
  return [
    generalSetting(GENERAL_SETTING_ANCHORS.fontSize, entries.fontSize),
    generalSetting(GENERAL_SETTING_ANCHORS.fontWeight, entries.fontWeight),
    generalSetting(GENERAL_SETTING_ANCHORS.lineHeight, entries.lineHeight),
    generalSetting(GENERAL_SETTING_ANCHORS.ligatures, entries.ligatures),
    ...(isMacUserAgent()
      ? [generalSetting(GENERAL_SETTING_ANCHORS.fontSmoothing, entries.fontSmoothing)]
      : [])
  ]
})
