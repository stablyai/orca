/** Settings language-picker label for a plugin language pack (#13031). */
export function pluginLanguagePackPickerLabel(pack: {
  displayName?: string
  locale: string
  pluginKey: string
}): string {
  return pack.displayName ?? `${pack.locale} — ${pack.pluginKey}`
}
