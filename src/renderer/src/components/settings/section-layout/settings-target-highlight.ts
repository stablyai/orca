import { createContext } from 'react'

export const SettingsTargetHighlightContext = createContext<string | null>(null)
export const SettingsTargetHighlightProvider = SettingsTargetHighlightContext.Provider
export const SETTINGS_TARGET_HIGHLIGHT_CLASS_NAME = 'settings-target-highlight'

const SETTINGS_TITLE_TARGET_PREFIX = 'settings-title:'

// Search entries without an anchor id target their rendered row by title.
export function getSettingsTitleTargetId(title: string): string {
  return `${SETTINGS_TITLE_TARGET_PREFIX}${title}`
}

export function parseSettingsTitleTargetId(targetId: string): string | null {
  return targetId.startsWith(SETTINGS_TITLE_TARGET_PREFIX)
    ? targetId.slice(SETTINGS_TITLE_TARGET_PREFIX.length)
    : null
}
