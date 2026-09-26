// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
// Nerd Fonts come last to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const FALLBACK_FONTS = [
  'SF Mono', // macOS 10.12+
  'Menlo', // macOS (older)
  'Monaco', // macOS (legacy)
  'Cascadia Mono', // Windows 11+
  'Consolas', // Windows Vista+
  'DejaVu Sans Mono', // Linux (common)
  'Liberation Mono', // Linux (common)
  'Orca Nerd Font Symbols', // bundled PUA fallback for OMP/Powerline glyphs
  'Symbols Nerd Font Mono', // purpose-built Nerd Fonts symbols-only fallback
  'MesloLGS Nerd Font', // p10k's recommended font; very common on zsh setups
  'JetBrainsMono Nerd Font', // widely installed; Ghostty ships a JBM-derived font
  'Hack Nerd Font', // common Nerd Font among Linux developers
  'monospace' // ultimate generic fallback
] as const

export function buildFontFamily(fontFamily: string, userFallbacks: readonly string[] = []): string {
  const trimmed = fontFamily.trim()
  const parts = trimmed ? [JSON.stringify(trimmed)] : []
  const configuredKeys = new Set<string>(trimmed ? [trimmed.toLowerCase()] : [])
  for (const candidate of userFallbacks) {
    const fallback = candidate.trim()
    const key = fallback.toLowerCase()
    // Why: a generic family ends CSS fallback resolution, so Orca owns the
    // final unquoted `monospace` entry rather than allowing it mid-stack.
    if (!fallback || key === 'monospace' || configuredKeys.has(key)) {
      continue
    }
    configuredKeys.add(key)
    parts.push(JSON.stringify(fallback))
  }

  for (const fallback of FALLBACK_FONTS) {
    const key = fallback.toLowerCase()
    if (!configuredKeys.has(key)) {
      configuredKeys.add(key)
      // Generic keywords like "monospace" are unquoted; named fonts are quoted.
      parts.push(fallback === 'monospace' ? fallback : JSON.stringify(fallback))
    }
  }
  return parts.join(', ')
}
