import { translate } from '@/i18n/i18n'

/** The light and dark code-editor theme slots shown in Appearance. */
export function getEditorThemeSlots() {
  return [
    {
      base: 'light' as const,
      title: translate('settings.appearance.editorTheme.light', 'Light editor theme'),
      description: translate(
        'settings.appearance.editorTheme.lightDescription',
        'Code editor, diff and notebook colors while the app is light.'
      )
    },
    {
      base: 'dark' as const,
      title: translate('settings.appearance.editorTheme.dark', 'Dark editor theme'),
      description: translate(
        'settings.appearance.editorTheme.darkDescription',
        'Code editor, diff and notebook colors while the app is dark.'
      )
    }
  ]
}
