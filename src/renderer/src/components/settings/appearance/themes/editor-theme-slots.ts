import type { Translate } from '@/i18n/use-translate'

/** The light and dark code-editor theme slots shown in Appearance. */
export function getEditorThemeSlots(t: Translate) {
  return [
    {
      base: 'light' as const,
      title: t('settings.appearance.editorTheme.light', 'Light editor theme'),
      description: t(
        'settings.appearance.editorTheme.lightDescription',
        'Code editor, diff and notebook colors while the app is light.'
      )
    },
    {
      base: 'dark' as const,
      title: t('settings.appearance.editorTheme.dark', 'Dark editor theme'),
      description: t(
        'settings.appearance.editorTheme.darkDescription',
        'Code editor, diff and notebook colors while the app is dark.'
      )
    }
  ]
}
