/** Plugin images reach the renderer only through this scheme, served by main from bytes it has
 *  verified; the renderer never loads a plugin or catalog image from anywhere else. */
export const PLUGIN_IMAGE_SCHEME = 'orca-plugin-image'

export type PluginImageReference =
  /** Bytes main verified and cached by hash (catalog images, preview images). */
  | { kind: 'sha'; sha256: string }
  /** An image an installed plugin declares, pinned to the installed content hash. */
  | { kind: 'installed'; pluginKey: string; contentHash: string; slot: string }

export type PluginHostImage = { url: string; alt: string; width?: number; height?: number }

export type PluginHostImages = {
  icon?: PluginHostImage
  cover?: PluginHostImage
  screenshots?: (PluginHostImage & { caption?: string; theme?: 'light' | 'dark' })[]
}

export function pluginShaImageUrl(sha256: string): string {
  return `${PLUGIN_IMAGE_SCHEME}://sha/${sha256}`
}

/** `slot` is `icon`, `cover`, `screenshot-<index>`, or a contribution's icon: `editor-<index>`
 *  (custom editors) or `new-file-<index>` (new files). */
export function pluginInstalledImageUrl(
  pluginKey: string,
  contentHash: string,
  slot: string
): string {
  return `${PLUGIN_IMAGE_SCHEME}://installed/${encodeURIComponent(pluginKey)}/${contentHash}/${slot}`
}

export function parsePluginImageUrl(url: string): PluginImageReference | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PLUGIN_IMAGE_SCHEME}:`) {
    return null
  }
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parsed.hostname === 'sha' && parts.length === 1 && /^[0-9a-f]{64}$/.test(parts[0] ?? '')) {
    return { kind: 'sha', sha256: parts[0] ?? '' }
  }
  const [key, contentHash, slot] = parts
  if (
    parsed.hostname === 'installed' &&
    parts.length === 3 &&
    key &&
    contentHash &&
    slot &&
    /^(?:[0-9a-f]{64}|dev)$/.test(contentHash) &&
    /^(?:icon|cover|(?:screenshot|editor|new-file)-\d{1,2})$/.test(slot)
  ) {
    return { kind: 'installed', pluginKey: decodeURIComponent(key), contentHash, slot }
  }
  return null
}
