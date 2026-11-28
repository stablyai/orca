/** Spellchecker dictionaries Chromium runs in editors and chat. */
export type SpellcheckLanguageSettings = {
  /** Empty or absent follows the OS language; macOS always uses the OS spellchecker's own language. */
  spellcheckLanguages?: string[]
}
