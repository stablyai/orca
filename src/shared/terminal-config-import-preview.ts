import type { GlobalSettings } from './global-settings-types'
import type { TerminalThemeSlot } from './terminal-color-overrides'
import { withImportedTerminalColorOverrides } from './terminal-theme-selection'

/** Terminal apps whose config Orca can import. */
export type TerminalConfigImportFormat = 'ghostty' | 'kitty'

/** Where an import reads from: the app's own config locations, or a file the user picks. */
export type TerminalConfigImportSource = { kind: 'auto' } | { kind: 'chooseFile' }

/** What a terminal config import would change, shown before the user accepts it. */
export type TerminalConfigImportPreview = {
  found: boolean
  /** The user dismissed the file picker; nothing was read. */
  canceled?: boolean
  configPath?: string
  configPaths?: string[]
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
  /** Theme name per slot the config selects; when set, the diff's override bags are already per slot. */
  terminalThemes?: Partial<Record<TerminalThemeSlot, string>>
  error?: string
}

/** Settings to write when the user accepts an import preview. */
export function terminalConfigImportSettingsUpdate(
  settings: Parameters<typeof withImportedTerminalColorOverrides>[0],
  preview: TerminalConfigImportPreview,
  systemPrefersDark: boolean
): Partial<GlobalSettings> {
  return preview.terminalThemes
    ? preview.diff
    : withImportedTerminalColorOverrides(settings, preview.diff, systemPrefersDark)
}
