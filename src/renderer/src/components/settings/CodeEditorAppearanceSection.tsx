import { lazy, Suspense, useState } from 'react'
import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { EditorColorThemePicker } from './EditorColorThemePicker'
import {
  getAvailableEditorColorThemeOptions,
  resolveMonacoThemeName,
  type EditorColorThemeValue
} from '@/lib/editor-theme'
import { translate } from '@/i18n/i18n'

// Why: the preview boots Monaco; loading it eagerly would pull Monaco into every Settings import.
const EditorColorThemePreview = lazy(() =>
  import('./EditorColorThemePreview').then((module) => ({
    default: module.EditorColorThemePreview
  }))
)

type CodeEditorAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  systemPrefersDark: boolean
  forceVisiblePrimary?: boolean
}

/** "Code Editor" section of Settings > Appearance: color theme picker + live
 *  Monaco preview — the editor-theme mirror of TerminalAppearanceSection.tsx. */
export function CodeEditorAppearanceSection({
  settings,
  updateSettings,
  systemPrefersDark,
  forceVisiblePrimary = false
}: CodeEditorAppearanceSectionProps): React.JSX.Element {
  const [themeSearch, setThemeSearch] = useState('')
  const selectedTheme: EditorColorThemeValue = settings.editorColorTheme ?? 'auto'
  const themeOptions = getAvailableEditorColorThemeOptions()
  const previewThemeName = resolveMonacoThemeName(selectedTheme, systemPrefersDark)

  const pickerTitle = translate(
    'auto.components.settings.CodeEditorAppearanceSection.pickerTitle',
    'Editor Color Theme'
  )
  const pickerDescription = translate(
    'auto.components.settings.CodeEditorAppearanceSection.pickerDescription',
    'Syntax highlighting theme used by file editors and diff views. "Follow App Theme" switches between the default light and dark themes.'
  )

  return (
    <section className="space-y-5">
      <SettingsSubsectionHeader
        className="items-center"
        title={translate(
          'auto.components.settings.CodeEditorAppearanceSection.catalogTitle',
          'Code Editor Themes'
        )}
      />

      <div className="ml-4 grid gap-6">
        <SearchableSetting
          title={pickerTitle}
          description={pickerDescription}
          keywords={[
            'editor',
            'code',
            'theme',
            'color',
            'syntax',
            'highlighting',
            'dark',
            'light',
            ...themeOptions.map((option) => option.label.toLowerCase())
          ]}
          forceVisible={forceVisiblePrimary}
        >
          <EditorColorThemePicker
            label={pickerTitle}
            description={pickerDescription}
            selectedTheme={selectedTheme}
            themeOptions={themeOptions}
            query={themeSearch}
            onQueryChange={setThemeSearch}
            onSelectTheme={(theme) => updateSettings({ editorColorTheme: theme })}
          />
        </SearchableSetting>

        <Suspense fallback={null}>
          <EditorColorThemePreview
            title={translate(
              'auto.components.settings.CodeEditorAppearanceSection.previewTitle',
              'Preview'
            )}
            description={translate(
              'auto.components.settings.CodeEditorAppearanceSection.previewDescription',
              'Shows the effective code editor theme.'
            )}
            themeName={previewThemeName}
          />
        </Suspense>
      </div>
    </section>
  )
}
