import type { GlobalSettings } from '../../../shared/global-settings-types'
import { PANEL_DESIGN_TOKEN_ALLOWLIST } from '../../../shared/plugins/plugin-panel-shell'
import { applyDocumentTheme, type DocumentThemePreference } from './document-theme'
import {
  APP_APPEARANCE_STYLE_PROPERTIES,
  resolveAppAppearanceDarkMode,
  resolveLeftSidebarStyleVariables
} from './left-sidebar-appearance'

const PLUGIN_BASE_TOKEN_PREFIX = '--orca-plugin-base-'
const EDITOR_BASE_TOKEN_PREFIX = '--orca-editor-base-'
const APP_APPEARANCE_BASE_TOKENS = [
  '--app-appearance-base-background',
  '--app-appearance-base-foreground'
] as const
const EDITOR_BASE_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--primary',
  '--primary-foreground',
  '--popover',
  '--popover-foreground',
  '--border',
  '--input',
  '--ring',
  '--editor-surface'
] as const

function pluginBaseProperty(token: string): string {
  return `${PLUGIN_BASE_TOKEN_PREFIX}${token.slice(2)}`
}

function editorBaseProperty(token: string): string {
  return `${EDITOR_BASE_TOKEN_PREFIX}${token.slice(2)}`
}

export function clearAppAppearanceFromDocument(root: HTMLElement = document.documentElement): void {
  const baseScheme = root.dataset.appAppearanceBaseScheme
  if (baseScheme === 'dark' || baseScheme === 'light') {
    root.classList.toggle('dark', baseScheme === 'dark')
    root.classList.toggle('light', baseScheme === 'light')
  }
  for (const property of APP_APPEARANCE_STYLE_PROPERTIES) {
    root.style.removeProperty(property)
  }
  for (const token of PANEL_DESIGN_TOKEN_ALLOWLIST) {
    root.style.removeProperty(pluginBaseProperty(token))
  }
  for (const token of EDITOR_BASE_TOKENS) {
    root.style.removeProperty(editorBaseProperty(token))
  }
  for (const token of APP_APPEARANCE_BASE_TOKENS) {
    root.style.removeProperty(token)
  }
  root.removeAttribute('data-app-appearance')
  root.removeAttribute('data-app-appearance-base-scheme')
}

export function applyDocumentAppearance(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean,
  options: {
    root?: HTMLElement
    theme?: DocumentThemePreference
    disableTransitions?: boolean
  } = {}
): void {
  const root = options.root ?? document.documentElement
  const theme = options.theme ?? settings?.theme ?? 'system'
  const effectiveSettings = settings && options.theme ? { ...settings, theme } : settings
  clearAppAppearanceFromDocument(root)
  applyDocumentTheme(theme, {
    root,
    matchMedia: () => ({ matches: systemPrefersDark }),
    disableTransitions: options.disableTransitions
  })
  applyAppAppearanceToDocument(effectiveSettings, systemPrefersDark, root)
}

export function applyAppAppearanceToDocument(
  settings: GlobalSettings | null | undefined,
  systemPrefersDark: boolean,
  root: HTMLElement = document.documentElement
): void {
  if (root.dataset.appAppearance) {
    clearAppAppearanceFromDocument(root)
  }
  const variables = resolveLeftSidebarStyleVariables(settings, systemPrefersDark)
  const darkMode = resolveAppAppearanceDarkMode(settings, systemPrefersDark)
  if (!variables || darkMode === undefined) {
    clearAppAppearanceFromDocument(root)
    return
  }

  const baseStyles = getComputedStyle(root)
  const baseTokenValues = APP_APPEARANCE_BASE_TOKENS.map((token) =>
    baseStyles.getPropertyValue(token).trim()
  )
  for (const token of PANEL_DESIGN_TOKEN_ALLOWLIST) {
    root.style.setProperty(pluginBaseProperty(token), baseStyles.getPropertyValue(token).trim())
  }
  for (const token of EDITOR_BASE_TOKENS) {
    root.style.setProperty(editorBaseProperty(token), baseStyles.getPropertyValue(token).trim())
  }
  APP_APPEARANCE_BASE_TOKENS.forEach((token, index) => {
    root.style.setProperty(token, baseTokenValues[index])
  })
  root.dataset.appAppearanceBaseScheme = root.classList.contains('dark') ? 'dark' : 'light'

  for (const [property, value] of Object.entries(variables)) {
    root.style.setProperty(property, value)
  }
  root.classList.toggle('dark', darkMode)
  root.classList.toggle('light', !darkMode)
  root.dataset.appAppearance = settings?.leftSidebarAppearanceMode ?? ''
}

export function getAppAppearancePluginBaseToken(token: string): string | null {
  if (!document.documentElement.dataset.appAppearance) {
    return null
  }
  return document.documentElement.style.getPropertyValue(pluginBaseProperty(token)).trim() || null
}
