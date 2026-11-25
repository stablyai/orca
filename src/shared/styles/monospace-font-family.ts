import { isPluginFontFamilyName } from '../plugins/contributions/plugin-font-contribution'
import { buildFontFamilyList, prepareFontFallbacks, splitFontFamilyList } from './font-family-list'

export const BUNDLED_SYMBOLS_FONT_FAMILY = 'Orca Nerd Font Symbols'

// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
// Nerd Fonts come last to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const FALLBACK_FONTS = [
  'SF Mono',
  'Menlo',
  'Monaco',
  'Cascadia Mono',
  'Consolas',
  'DejaVu Sans Mono',
  'Liberation Mono',
  BUNDLED_SYMBOLS_FONT_FAMILY,
  'Symbols Nerd Font Mono',
  'MesloLGS Nerd Font',
  'JetBrainsMono Nerd Font',
  'Hack Nerd Font',
  'monospace'
] as const

const FALLBACKS = prepareFontFallbacks(FALLBACK_FONTS)

export function buildFontFamily(fontFamily: string): string {
  const families = splitFontFamilyList(fontFamily)
  if (families.length > 1) {
    return buildFontFamilyList(families, FALLBACKS)
  }
  // Why: a single family is quoted as typed, keyword or not, and drops each fallback it ends with.
  const family = families[0] ?? ''
  const parts = family ? [`"${family}"`] : []
  const lowerFamily = family.toLowerCase()
  // Why: a plugin family such as "Menlo (acme.fonts)" is never a fallback, so it must keep all of them.
  // Why: endsWith, not includes, so "Cascadia Mono, D2Coding" does not drop "Cascadia Mono"
  // but "ui-monospace" still drops "monospace".
  const isPluginFamily = isPluginFontFamilyName(family)
  for (const fallback of FALLBACKS) {
    if (isPluginFamily || !lowerFamily.endsWith(fallback.lower)) {
      parts.push(fallback.quoted)
    }
  }
  return parts.join(', ')
}
