import type { GlobalSettings } from './global-settings-types'

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
  error?: string
}
