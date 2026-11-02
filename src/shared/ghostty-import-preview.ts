import type { GlobalSettings } from './global-settings-types'
import type { TerminalThemeSlot } from './terminal-color-overrides'
import { withImportedTerminalColorOverrides } from './terminal-theme-selection'

/** Where a Ghostty import reads from: Ghostty's own config locations, or a file the user picks. */
export type GhosttyImportSource = { kind: 'auto' } | { kind: 'chooseFile' }

/** What a Ghostty config import would change, shown before the user accepts it. */
export type GhosttyImportPreview = {
  found: boolean
  /** The user dismissed the file picker; nothing was read. */
  canceled?: boolean
  configPath?: string
  configPaths?: string[]
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
  /** Theme name per slot the config's `theme` selects; when set, the diff's override bags are already per slot. */
  terminalThemes?: Partial<Record<TerminalThemeSlot, string>>
  error?: string
}

/** Settings to write when the user accepts a Ghostty import preview. */
export function ghosttyImportSettingsUpdate(
  settings: Parameters<typeof withImportedTerminalColorOverrides>[0],
  preview: GhosttyImportPreview,
  systemPrefersDark: boolean
): Partial<GlobalSettings> {
  return preview.terminalThemes
    ? preview.diff
    : withImportedTerminalColorOverrides(settings, preview.diff, systemPrefersDark)
}
