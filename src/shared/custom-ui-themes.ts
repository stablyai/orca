export type CustomUiTheme = {
  id: string
  name: string
  mode: 'dark' | 'light'
  variables: Record<string, string>
}

/** Tracks which CSS custom properties we've set, so we only clear our own. */
const appliedCustomVarKeys = new Set<string>()

export function clearCustomUiThemeVariables(root: HTMLElement = document.documentElement): void {
  appliedCustomVarKeys.forEach((key) => root.style.removeProperty(key))
  appliedCustomVarKeys.clear()
}

export function applyCustomUiThemeVariables(
  theme: CustomUiTheme,
  root: HTMLElement = document.documentElement
): void {
  clearCustomUiThemeVariables(root)

  for (const [key, val] of Object.entries(theme.variables)) {
    root.style.setProperty(key, val)
    appliedCustomVarKeys.add(key)

    // Mirror --sidebar-* → --worktree-sidebar-* so the worktree panel inherits sidebar colours
    if (key.startsWith('--sidebar')) {
      const mirrorKey = key.replace(/^--sidebar/, '--worktree-sidebar')
      root.style.setProperty(mirrorKey, val)
      appliedCustomVarKeys.add(mirrorKey)
    }
  }
}

/**
 * Normalizes a theme name into a valid URL/ID-friendly slug.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Pushes light/dark themes into `themes` when the corresponding vars are non-empty. */
function pushModeThemes(
  themes: CustomUiTheme[],
  slug: string,
  name: string,
  lightVars: Record<string, string>,
  darkVars: Record<string, string>
): void {
  if (Object.keys(lightVars).length > 0) {
    themes.push({
      id: `manual:${slug}-light`,
      name: `${name} Light`,
      mode: 'light',
      variables: lightVars
    })
  }
  if (Object.keys(darkVars).length > 0) {
    themes.push({
      id: `manual:${slug}-dark`,
      name: `${name} Dark`,
      mode: 'dark',
      variables: darkVars
    })
  }
}

/**
 * Parses raw CSS variables block (such as Tweakcn/Tailwind v4 theme output)
 */
export function parseCssTheme(name: string, cssContent: string): CustomUiTheme[] {
  const extractVariables = (selector: string): Record<string, string> => {
    const vars: Record<string, string> = {}
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`, 'i')
    const match = cssContent.match(regex)

    if (match) {
      match[1].split(';').forEach((decl) => {
        const idx = decl.indexOf(':')
        if (idx !== -1) {
          const key = decl.slice(0, idx).trim()
          const val = decl.slice(idx + 1).trim()
          if (key.startsWith('--') && val) {
            if (/url\s*\(/i.test(val)) {
              // Security block: skip url(...) to prevent unsolicited tracking requests.
              return
            }
            vars[key] = val
          }
        }
      })
    }
    return vars
  }

  const themes: CustomUiTheme[] = []
  pushModeThemes(themes, slugify(name), name, extractVariables(':root'), extractVariables('.dark'))
  return themes
}

/** Matches bare HSL values like "0 0% 100%" or "0 0% 100% / 0.5" that need an hsl() wrapper. */
const BARE_HSL = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%(?:\s*\/.*)?$/

/**
 * Parses standard Shadcn JSON theme format
 */
export function parseJsonTheme(jsonContent: string): CustomUiTheme[] {
  try {
    const parsed = JSON.parse(jsonContent)
    if (!parsed || typeof parsed !== 'object') {
      return []
    }

    const name =
      typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported'
    const { cssVars } = parsed
    if (!cssVars || typeof cssVars !== 'object') {
      return []
    }

    const mapVariables = (rawVars: unknown): Record<string, string> => {
      if (!rawVars || typeof rawVars !== 'object' || Array.isArray(rawVars)) {
        return {}
      }
      const output: Record<string, string> = {}
      for (const [key, val] of Object.entries(rawVars as Record<string, unknown>)) {
        if (typeof val !== 'string') {
          continue
        }
        if (/url\s*\(/i.test(val)) {
          // Security block: skip url(...) to prevent unsolicited tracking requests.
          continue
        }
        const cssKey = key.startsWith('--') ? key : `--${key}`
        const trimmed = val.trim()
        output[cssKey] = BARE_HSL.test(trimmed) ? `hsl(${trimmed})` : trimmed
      }
      return output
    }

    const themeVars =
      cssVars.theme && typeof cssVars.theme === 'object' && !Array.isArray(cssVars.theme)
        ? cssVars.theme
        : {}
    const lightSource =
      cssVars.light && typeof cssVars.light === 'object' && !Array.isArray(cssVars.light)
        ? cssVars.light
        : {}
    const darkSource =
      cssVars.dark && typeof cssVars.dark === 'object' && !Array.isArray(cssVars.dark)
        ? cssVars.dark
        : {}

    const lightMerged = { ...themeVars, ...lightSource }
    const darkMerged = { ...themeVars, ...darkSource }

    const themes: CustomUiTheme[] = []
    pushModeThemes(themes, slugify(name), name, mapVariables(lightMerged), mapVariables(darkMerged))
    return themes
  } catch {
    return []
  }
}

/**
 * Unified entry point — auto-detects JSON vs CSS input.
 */
export function parseTheme(name: string, content: string): CustomUiTheme[] {
  const trimmed = content.trim()
  return trimmed.startsWith('{') ? parseJsonTheme(trimmed) : parseCssTheme(name, trimmed)
}
