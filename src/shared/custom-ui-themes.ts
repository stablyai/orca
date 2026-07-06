export type CustomUiTheme = {
  id: string
  name: string
  mode: 'dark' | 'light'
  variables: Record<string, string>
}

const SHADCN_CSS_VARS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
  '--worktree-sidebar',
  '--worktree-sidebar-foreground',
  '--worktree-sidebar-accent',
  '--worktree-sidebar-accent-foreground',
  '--worktree-sidebar-border',
  '--worktree-sidebar-ring'
]

export function clearCustomUiThemeVariables(root: HTMLElement = document.documentElement): void {
  SHADCN_CSS_VARS.forEach((v) => root.style.removeProperty(v))
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

/**
 * Parses raw CSS variables block (such as Tweakcn/Tailwind v4 theme output)
 */
export function parseCssTheme(name: string, cssContent: string): CustomUiTheme[] {
  const themes: CustomUiTheme[] = []

  const extractVariables = (selector: string): Record<string, string> => {
    const vars: Record<string, string> = {}
    // Matches the selector and its braces contents, case-insensitively
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`, 'i')
    const match = cssContent.match(regex)
    
    if (match) {
      const declarations = match[1].split(';')
      declarations.forEach((decl) => {
        const separatorIdx = decl.indexOf(':')
        if (separatorIdx !== -1) {
          const key = decl.slice(0, separatorIdx).trim()
          const val = decl.slice(separatorIdx + 1).trim()
          if (key.startsWith('--') && val) {
            vars[key] = val
          }
        }
      })
    }
    return vars
  }

  const lightVars = extractVariables(':root')
  const darkVars = extractVariables('.dark')

  const slug = slugify(name)

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

  return themes
}

/**
 * Parses standard Shadcn JSON theme format
 */
export function parseJsonTheme(jsonContent: string): CustomUiTheme[] {
  try {
    const parsed = JSON.parse(jsonContent)
    if (!parsed || typeof parsed !== 'object') {
      return []
    }

    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported'
    const cssVars = parsed.cssVars
    if (!cssVars || typeof cssVars !== 'object') {
      return []
    }

    const themes: CustomUiTheme[] = []
    const slug = slugify(name)

    const mapVariables = (rawVars: unknown): Record<string, string> => {
      if (!rawVars || typeof rawVars !== 'object' || Array.isArray(rawVars)) {
        return {}
      }
      const input = rawVars as Record<string, unknown>
      const output: Record<string, string> = {}

      Object.entries(input).forEach(([key, val]) => {
        if (typeof val !== 'string') {
          return
        }

        const cssKey = key.startsWith('--') ? key : `--${key}`
        const trimmedVal = val.trim()

        // Wrap Shadcn raw HSL space-separated values (e.g. "0 0% 100%") in hsl() function
        const needsHslWrapper =
          /^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(trimmedVal) ||
          /^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%\s*\/.*$/.test(trimmedVal)

        output[cssKey] = needsHslWrapper ? `hsl(${trimmedVal})` : trimmedVal
      })

      return output
    }

    if (cssVars.light) {
      themes.push({
        id: `manual:${slug}-light`,
        name: `${name} Light`,
        mode: 'light',
        variables: mapVariables(cssVars.light)
      })
    }

    if (cssVars.dark) {
      themes.push({
        id: `manual:${slug}-dark`,
        name: `${name} Dark`,
        mode: 'dark',
        variables: mapVariables(cssVars.dark)
      })
    }

    return themes
  } catch {
    return []
  }
}
