/** Plugin images reach the renderer only through this scheme, served by main from bytes it has
 *  verified; the renderer never loads a plugin or catalog image from anywhere else. */
export const PLUGIN_IMAGE_SCHEME = 'orca-plugin-image'

export type PluginCatalogImageIdentity = {
  kind: 'icon' | 'cover' | 'screenshot'
  width: number
  height: number
}

export type PluginImageReference =
  /** Bytes main verified and cached by hash (catalog images, preview images). */
  | { kind: 'sha'; sha256: string; image?: PluginCatalogImageIdentity }
  /** An image an installed plugin declares, pinned to the installed content hash. */
  | { kind: 'installed'; pluginKey: string; contentHash: string; slot: string }

export type PluginHostImage = { url: string; alt: string; width?: number; height?: number }

export type PluginHostImages = {
  icon?: PluginHostImage
  cover?: PluginHostImage
  screenshots?: (PluginHostImage & { caption?: string; theme?: 'light' | 'dark' })[]
}

export function pluginShaImageUrl(sha256: string, image?: PluginCatalogImageIdentity): string {
  const url = `${PLUGIN_IMAGE_SCHEME}://sha/${sha256}`
  return image ? `${url}?kind=${image.kind}&width=${image.width}&height=${image.height}` : url
}

/** `slot` is `icon`, `cover`, `screenshot-<index>`, a contribution's icon: `editor-<index>`
 *  (custom editors) or `new-file-<index>` (new files), an app theme's background: `theme-<index>`
 *  or its video `theme-<index>-video`, or a font file: `font-<family index>-<face index>`. */
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
    const kind = parsed.searchParams.get('kind')
    if (kind === null) {
      return { kind: 'sha', sha256: parts[0] ?? '' }
    }
    const width = Number(parsed.searchParams.get('width'))
    const height = Number(parsed.searchParams.get('height'))
    if (
      (kind !== 'icon' && kind !== 'cover' && kind !== 'screenshot') ||
      !Number.isInteger(width) ||
      width < 1 ||
      width > 4096 ||
      !Number.isInteger(height) ||
      height < 1 ||
      height > 4096
    ) {
      return null
    }
    return { kind: 'sha', sha256: parts[0] ?? '', image: { kind, width, height } }
  }
  const [key, contentHash, slot] = parts
  if (
    parsed.hostname === 'installed' &&
    parts.length === 3 &&
    key &&
    contentHash &&
    slot &&
    /^(?:[0-9a-f]{64}|[0-9a-f]{32}|dev)$/.test(contentHash) &&
    /^(?:icon|cover|(?:screenshot|editor|new-file)-\d{1,2}|theme-(?:0|[1-9]\d{0,2})(?:-video)?|font-\d-\d)$/.test(
      slot
    )
  ) {
    return { kind: 'installed', pluginKey: decodeURIComponent(key), contentHash, slot }
  }
  return null
}

/** Only the images main serves over the plugin image scheme. Why: entries can come from a paired
 *  remote host, and the renderer's CSP allows web images, so any other URL could hotlink. */
export function servedPluginHostImages(
  images: PluginHostImages | undefined
): PluginHostImages | undefined {
  if (!images) {
    return undefined
  }
  const served = <T extends PluginHostImage>(image: T | undefined): T | undefined =>
    image && parsePluginImageUrl(image.url) ? image : undefined
  const icon = served(images.icon)
  const cover = served(images.cover)
  const screenshots = images.screenshots?.filter((shot) => served(shot))
  return {
    ...(icon ? { icon } : {}),
    ...(cover ? { cover } : {}),
    ...(screenshots?.length ? { screenshots } : {})
  }
}
