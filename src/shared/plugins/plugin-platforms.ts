import { z } from 'zod'

/** Operating systems a plugin can declare in `platforms`. Matches the
 *  `process.platform` values of the desktop builds Orca ships. */
export const PLUGIN_PLATFORMS = ['darwin', 'linux', 'win32'] as const

export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number]

export const pluginPlatformsSchema = z
  .array(z.enum(PLUGIN_PLATFORMS))
  .min(1)
  .max(PLUGIN_PLATFORMS.length)
  .refine((platforms) => new Set(platforms).size === platforms.length, 'duplicate platform')

/** Absent `platforms` means every platform. Plugins always run on the local
 *  Orca host (SSH workspaces included), so callers pass that host's platform. */
export function isPluginPlatformSupported(
  platforms: readonly PluginPlatform[] | undefined,
  hostPlatform: string
): boolean {
  return platforms === undefined || platforms.some((platform) => platform === hostPlatform)
}

/** Stable wording the renderer maps to translated copy. */
export function unsupportedPluginPlatformError(
  platforms: readonly PluginPlatform[],
  hostPlatform: string
): string {
  return `not available on this platform: supports ${platforms.join(', ')} (this is ${hostPlatform})`
}
