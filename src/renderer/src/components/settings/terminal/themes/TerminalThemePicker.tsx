import type React from 'react'
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { ThemeColorSwatch } from '../../../plugins/page/PluginThemeSwatch'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { SettingsSearchableSelect } from '../../form-controls/SettingsSearchableSelect'
import { useTranslate } from '@/i18n/use-translate'
import type { TerminalThemeOption } from '@/lib/terminal-theme'

type ThemePickerProps = {
  label: string
  description: string
  selectedTheme: string
  themeOptions: TerminalThemeOption[]
  onSelectTheme: (theme: string) => void
  onDeleteImportedTheme?: (theme: TerminalThemeOption) => void
  /** After import, open the picker at the Imported group. */
  importedHighlightSignal?: number
}

export function ThemePicker({
  label,
  description,
  selectedTheme,
  themeOptions,
  onSelectTheme,
  onDeleteImportedTheme,
  importedHighlightSignal
}: ThemePickerProps): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Settings search unmounts this row; seed from the prop so a remount doesn't replay an old import.
  const [handledImportSignal, setHandledImportSignal] = useState(importedHighlightSignal ?? 0)
  const importedLabel = t(
    'auto.components.settings.SettingsFormControls.imported_themes',
    'Imported'
  )

  if (importedHighlightSignal && importedHighlightSignal !== handledImportSignal) {
    setHandledImportSignal(importedHighlightSignal)
    setQuery(importedLabel)
    setOpen(true)
  }

  const groups = [
    {
      key: 'built-in',
      heading: t('auto.components.settings.SettingsFormControls.builtin_themes', 'Built-in')
    },
    {
      key: 'imported',
      heading: importedLabel
    },
    {
      key: 'plugin',
      heading: t('auto.components.settings.SettingsFormControls.plugin_themes', 'Plugins')
    }
  ].map((group) => ({
    ...group,
    options: themeOptions
      .filter((theme) => theme.group === group.key)
      .map((theme) => ({
        value: theme.value,
        label: theme.label,
        keywords: [theme.sourceLabel ?? '', theme.mode ?? ''],
        detail: theme.sourceLabel,
        icon: theme.previewTheme ? (
          <ThemeColorSwatch
            background={theme.previewTheme.background ?? 'var(--background)'}
            accent={theme.previewTheme.blue ?? theme.previewTheme.foreground ?? 'var(--foreground)'}
          />
        ) : undefined,
        action:
          theme.group === 'imported' && onDeleteImportedTheme
            ? {
                label: t(
                  'auto.components.settings.SettingsFormControls.delete_imported_theme',
                  'Delete {{value0}}',
                  { value0: theme.label }
                ),
                icon: <Trash2 />,
                onSelect: () => onDeleteImportedTheme(theme)
              }
            : undefined
      }))
  }))

  return (
    <SettingsRow
      label={label}
      description={description}
      className="flex-wrap"
      control={
        <SettingsSearchableSelect
          ariaLabel={label}
          value={selectedTheme}
          groups={groups}
          onValueChange={onSelectTheme}
          allowReselect
          open={open}
          onOpenChange={setOpen}
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={t(
            'auto.components.settings.SettingsFormControls.search_terminal_themes',
            'Search terminal themes'
          )}
          emptyText={t(
            'auto.components.settings.SettingsFormControls.ceefb9d7f1',
            'No themes found.'
          )}
        />
      }
    />
  )
}
