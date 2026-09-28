import type { GlobalSettings } from './global-settings-types'

/** What a Ghostty config import would change, shown before the user accepts it. */
export type GhosttyImportPreview = {
  found: boolean
  configPath?: string
  configPaths?: string[]
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
  error?: string
}
