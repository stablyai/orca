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
  // Why: a single family is quoted via JSON.stringify (preserves inner quotes) and drops fallbacks
  // it exactly matches or ends with (so "ui-monospace" drops "monospace" but
  // "Cascadia Mono, D2Coding" does not drop "Cascadia Mono").
  const family = families[0] ?? ''
  const parts = family ? [JSON.stringify(family)] : []
  const lowerFamily = family.toLowerCase()
  const isPluginFamily = isPluginFontFamilyName(family)
  for (const fallback of FALLBACKS) {
    const lowerFallback = fallback.lower
    const exactMatch = lowerFamily === lowerFallback
    // endsWith catches keyword containment: "ui-monospace" ends with "monospace".
    // But only if the matched suffix is a full word boundary (preceded by '-' or start).
    const suffixMatch =
      lowerFamily.endsWith(lowerFallback) &&
      (lowerFamily.length === lowerFallback.length ||
        lowerFamily[lowerFamily.length - lowerFallback.length - 1] === '-')
    if (isPluginFamily || (!exactMatch && !suffixMatch)) {
      parts.push(fallback.quoted)
    }
  }
  return parts.join(', ')
}
