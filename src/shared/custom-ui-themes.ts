export type CustomUiTheme = {
  id: string
  name: string
  mode: 'dark' | 'light'
  variables: Record<string, string>
}

export type CustomUiThemeRoot = {
  style: Pick<CSSStyleDeclaration, 'removeProperty' | 'setProperty'>
}

export const MAX_CUSTOM_UI_THEMES = 50
export const MAX_CUSTOM_UI_THEME_INPUT_LENGTH = 256 * 1024
export const MAX_CUSTOM_UI_THEME_NAME_LENGTH = 80
const MAX_CUSTOM_UI_THEME_VARIABLES = 256
const MAX_CUSTOM_UI_THEME_VARIABLE_NAME_LENGTH = 96
const MAX_CUSTOM_UI_THEME_VARIABLE_VALUE_LENGTH = 2048
const appliedCustomVarKeysByRoot = new WeakMap<CustomUiThemeRoot, Set<string>>()
const UNSAFE_THEME_VALUE =
  /\\|(?:url|(?:-webkit-)?image-set|image|cross-fade|src)\s*\(|(?:^|[\s("'=])(?:blob|data|file|https?):/i

function isSafeThemeVariable(key: string, value: unknown): value is string {
  return (
    /^--[a-zA-Z0-9_-]+$/.test(key) &&
    key.length <= MAX_CUSTOM_UI_THEME_VARIABLE_NAME_LENGTH &&
    typeof value === 'string' &&
    value.length <= MAX_CUSTOM_UI_THEME_VARIABLE_VALUE_LENGTH &&
    !UNSAFE_THEME_VALUE.test(value)
  )
}

export function clearCustomUiThemeVariables(
  root: CustomUiThemeRoot = document.documentElement
): void {
  const keys = appliedCustomVarKeysByRoot.get(root)
  keys?.forEach((key) => root.style.removeProperty(key))
  appliedCustomVarKeysByRoot.delete(root)
}

export function applyCustomUiThemeVariables(
  theme: CustomUiTheme,
  root: CustomUiThemeRoot = document.documentElement
): void {
  clearCustomUiThemeVariables(root)
  const appliedKeys = new Set<string>()

  for (const [key, val] of Object.entries(theme.variables).slice(
    0,
    MAX_CUSTOM_UI_THEME_VARIABLES
  )) {
    if (!isSafeThemeVariable(key, val)) {
      continue
    }
    root.style.setProperty(key, val)
    appliedKeys.add(key)

    if (/^--sidebar(?:-|$)/.test(key)) {
      const mirrorKey = key.replace(/^--sidebar/, '--worktree-sidebar')
      root.style.setProperty(mirrorKey, val)
      appliedKeys.add(mirrorKey)
    }
  }

  appliedCustomVarKeysByRoot.set(root, appliedKeys)
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug) {
    return slug
  }
  let hash = 2166136261
  for (const character of name) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619)
  }
  return `theme-${(hash >>> 0).toString(36)}`
}

function normalizeThemeName(name: string, fallback: string): string {
  return name.trim().slice(0, MAX_CUSTOM_UI_THEME_NAME_LENGTH) || fallback
}

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

export function parseCssTheme(name: string, cssContent: string): CustomUiTheme[] {
  if (cssContent.length > MAX_CUSTOM_UI_THEME_INPUT_LENGTH) {
    return []
  }
  const normalizedName = normalizeThemeName(name, 'Imported')
  const extractVariables = (selector: string): Record<string, string> => {
    const vars: Record<string, string> = {}
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`, 'i')
    const match = cssContent.match(regex)

    if (match) {
      for (const decl of match[1].split(';')) {
        if (Object.keys(vars).length >= MAX_CUSTOM_UI_THEME_VARIABLES) {
          break
        }
        const idx = decl.indexOf(':')
        if (idx !== -1) {
          const key = decl.slice(0, idx).trim()
          const val = decl.slice(idx + 1).trim()
          if (val && isSafeThemeVariable(key, val)) {
            vars[key] = val
          }
        }
      }
    }
    return vars
  }

  const themes: CustomUiTheme[] = []
  pushModeThemes(
    themes,
    slugify(normalizedName),
    normalizedName,
    extractVariables(':root'),
    extractVariables('.dark')
  )
  return themes
}

const BARE_HSL = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%(?:\s*\/.*)?$/

export function parseJsonTheme(jsonContent: string): CustomUiTheme[] {
  if (jsonContent.length > MAX_CUSTOM_UI_THEME_INPUT_LENGTH) {
    return []
  }
  try {
    const parsed = JSON.parse(jsonContent)
    if (!parsed || typeof parsed !== 'object') {
      return []
    }

    const name = normalizeThemeName(typeof parsed.name === 'string' ? parsed.name : '', 'Imported')
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
        if (
          Object.keys(output).length >= MAX_CUSTOM_UI_THEME_VARIABLES ||
          !isSafeThemeVariable(key.startsWith('--') ? key : `--${key}`, val)
        ) {
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

export function parseTheme(name: string, content: string): CustomUiTheme[] {
  const trimmed = content.trim()
  return trimmed.startsWith('{') ? parseJsonTheme(trimmed) : parseCssTheme(name, trimmed)
}
