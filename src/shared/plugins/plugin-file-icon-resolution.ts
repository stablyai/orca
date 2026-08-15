import type { PluginIconThemeRegistration } from './plugin-icon-theme-artifact'

// Why: the parser's null-prototype tables do not survive the registry copy or
// the IPC structured clone, so a file named `constructor` would otherwise hit
// Object.prototype and short-circuit the fallback with a non-id value.
function lookup(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

function getFilename(filePath: string | undefined | null): string {
  if (!filePath) {
    return ''
  }
  // Why: SSH worktrees report POSIX paths while Windows hosts report `\`;
  // split on both so icon lookup does not depend on the host separator.
  return filePath.split(/[\\/]/).at(-1) ?? ''
}

/**
 * Resolves a file to a theme icon URL, or null when the theme has no opinion
 * and the caller should fall back to Orca's built-in Lucide icons.
 */
export function resolvePluginFileIconUrl(
  theme: PluginIconThemeRegistration | null | undefined,
  filePath: string | undefined | null
): string | null {
  if (!theme) {
    return null
  }
  const filename = getFilename(filePath).toLowerCase()
  if (!filename) {
    return null
  }

  const byName = lookup(theme.fileNames, filename)
  if (byName) {
    return lookup(theme.icons, byName) ?? null
  }

  // Longest suffix first so `d.ts` beats `ts` for `types.d.ts`. Every suffix is
  // tried so a theme can key an arbitrarily long compound extension.
  const segments = filename.split('.')
  for (let take = segments.length - 1; take >= 1; take -= 1) {
    const suffix = segments.slice(segments.length - take).join('.')
    const definitionId = lookup(theme.fileExtensions, suffix)
    if (definitionId) {
      return lookup(theme.icons, definitionId) ?? null
    }
  }

  return theme.defaultIcon ? (lookup(theme.icons, theme.defaultIcon) ?? null) : null
}

/**
 * Picks the theme to render with. Until a user-facing picker lands, a single
 * contributed theme activates on its own; ambiguity falls back to built-ins.
 */
export function selectActivePluginIconTheme(
  themes: readonly PluginIconThemeRegistration[],
  activeThemeId?: string | null
): PluginIconThemeRegistration | null {
  if (activeThemeId) {
    return themes.find((theme) => theme.id === activeThemeId) ?? null
  }
  return themes.length === 1 ? (themes[0] ?? null) : null
}
