import { isPluginFontFamilyName } from '../plugins/contributions/plugin-font-contribution'

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

/**
 * Split a user-entered stack on commas outside quotes, dropping each family's surrounding
 * quotes. A comma-separated value in the single font setting used to be quoted as one
 * unresolvable family name, so a fallback stack could never be typed (#42938).
 */
function splitFontStack(value: string): string[] {
  const families: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of value) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ',') {
      const trimmedFamily = current.trim()
      if (trimmedFamily) {
        families.push(trimmedFamily)
      }
      current = ''
    } else {
      current += ch
    }
  }
  const tail = current.trim()
  if (tail) {
    families.push(tail)
  }
  return families
}

export function buildFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  // Why: a plugin family such as "Menlo (acme.fonts)" is never a fallback list, so it stays whole.
  const isPluginFamily = isPluginFontFamilyName(trimmed)
  const families = trimmed ? (isPluginFamily ? [trimmed] : splitFontStack(trimmed)) : []
  const parts = families.map((family) => `"${family}"`)
  const lowerParts = parts.map((p) => p.toLowerCase())
  for (const fallback of FALLBACK_FONTS) {
    const lower = fallback.toLowerCase()
    if (isPluginFamily || !lowerParts.some((p) => p.includes(lower))) {
      // Generic keywords like "monospace" are unquoted; named fonts are quoted.
      parts.push(fallback === 'monospace' ? fallback : `"${fallback}"`)
    }
  }
  return parts.join(', ')
}
