import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

/**
 * Desktop plugin frames run as `<webview>` guests, one partition (session, process, storage) per
 * plugin, served from `orca-plugin-frame://<key>/<path>`. Main and renderer derive the same key.
 * See docs/reference/plugin-isolated-frames.md.
 */

export const PLUGIN_FRAME_SCHEME = 'orca-plugin-frame'
export const PLUGIN_FRAME_PARTITION_PREFIX = 'persist:orca-plugin-'
/** `sendToHost` / `webview.send` channel carrying the `{orca:1, …}` envelopes. */
export const PLUGIN_FRAME_IPC_CHANNEL = 'orca-plugin-frame'
/** Preload → host only: modifier chords from trusted keydowns, the one source of a guest save. */
export const PLUGIN_FRAME_KEY_CHANNEL = 'orca-plugin-frame-key'
/** One-shot main-world handoff from the guest preload to Orca's injected frame shell. */
export const PLUGIN_FRAME_TRANSPORT_GLOBAL = '__orcaPluginFrameTransport'
/** One-shot main-world hook letting Orca's declarative boot script post `ui.*` events. */
export const PLUGIN_DECLARATIVE_POST_GLOBAL = '__orcaDeclarativePost'
/** Orca-served files under the reserved prefix (plugin-frame-protocol.ts). */
export const PLUGIN_DECLARATIVE_HOST_FILE = 'declarative-host.html'
export const PLUGIN_DECLARATIVE_RUNTIME_FILE = 'orca-runtime.mjs'
/** Paths under this prefix are reserved for files Orca ships; plugin files there are never served. */
export const PLUGIN_FRAME_RESERVED_SEGMENT = '__orca'

const FRAME_KEY_PATTERN = /^[0-9a-f]{16}$/

/** First 16 hex chars of sha256(`<publisher>.<id>`): stable per plugin across versions. */
export function pluginFrameKey(pluginKey: string): string {
  return bytesToHex(sha256(utf8ToBytes(pluginKey))).slice(0, 16)
}

export function isPluginFrameKey(value: string): boolean {
  return FRAME_KEY_PATTERN.test(value)
}

export function pluginFramePartition(frameKey: string): string {
  return `${PLUGIN_FRAME_PARTITION_PREFIX}${frameKey}`
}

/** The frame key of an `orca-plugin-` partition, or null for any other partition. */
export function readPluginFramePartitionKey(partition: string): string | null {
  if (!partition.startsWith(PLUGIN_FRAME_PARTITION_PREFIX)) {
    return null
  }
  const key = partition.slice(PLUGIN_FRAME_PARTITION_PREFIX.length)
  return isPluginFrameKey(key) ? key : null
}

export function pluginFrameOrigin(frameKey: string): string {
  return `${PLUGIN_FRAME_SCHEME}://${frameKey}`
}

/** `relativePath` is a manifest path inside the plugin root (`/` separated). */
export function pluginFrameUrl(frameKey: string, relativePath: string): string {
  const segments = relativePath
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0 && segment !== '.')
    .map(encodeURIComponent)
  return `${pluginFrameOrigin(frameKey)}/${segments.join('/')}`
}

export type PluginFrameUrlTarget = {
  frameKey: string
  /** Decoded segments inside the plugin root; never empty, `.`, `..`, or separator-bearing. */
  segments: string[]
  reserved: boolean
}

export function parsePluginFrameUrl(url: string): PluginFrameUrlTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (
    parsed.protocol !== `${PLUGIN_FRAME_SCHEME}:` ||
    !isPluginFrameKey(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== ''
  ) {
    return null
  }
  const raw = parsed.pathname.split('/').slice(1)
  const segments: string[] = []
  for (const encoded of raw) {
    let segment: string
    try {
      segment = decodeURIComponent(encoded)
    } catch {
      return null
    }
    // Why decoded checks: `%2F` or `%5C` must not smuggle a separator into one segment.
    // Why trailing dots and spaces: Windows strips them, so `__orca.` or `app.js ` would name
    // another file than the one checked.
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      /[\\/\0:]/.test(segment) ||
      /[. ]$/.test(segment)
    ) {
      return null
    }
    segments.push(segment)
  }
  if (segments.length === 0) {
    return null
  }
  return {
    frameKey: parsed.hostname,
    segments,
    // Why any case: plugin folders may sit on case-insensitive file systems.
    reserved: segments[0]?.toLowerCase() === PLUGIN_FRAME_RESERVED_SEGMENT
  }
}

/** True when `url` is a document or resource of exactly this plugin's frame origin. */
export function isPluginFrameOriginUrl(url: string, frameKey: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${PLUGIN_FRAME_SCHEME}:` && parsed.hostname === frameKey
  } catch {
    return false
  }
}

/** The hidden page that runs a declarative panel's module `entry` (a manifest path). */
export function pluginDeclarativeHostUrl(frameKey: string, entry: string): string {
  const host = pluginFrameUrl(
    frameKey,
    `${PLUGIN_FRAME_RESERVED_SEGMENT}/${PLUGIN_DECLARATIVE_HOST_FILE}`
  )
  return `${host}?entry=${encodeURIComponent(entry)}`
}
