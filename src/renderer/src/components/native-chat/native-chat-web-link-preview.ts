import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  linkPreviewSize,
  type LinkPreview,
  type LinkPreviewResult
} from '../../../../shared/link-preview'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

const previews = createHoverPreviewCache<LinkPreview>({
  freshMs: 10 * 60_000,
  maxEntries: 200,
  // Preview images are kept as data URLs; bound their total, not just their count.
  budget: { maxBytes: 20 * 1024 * 1024, sizeOf: linkPreviewSize }
})

// Hosts only reachable on the user's own network never get a card; main refuses them anyway.
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

/** The http(s) URL a hover card may preview, without its fragment; null for anything else. */
export function previewableWebUrl(href: string | undefined): string | null {
  if (!href) {
    return null
  }
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    !host.includes('.') ||
    /^[\d.]+$/.test(host) ||
    host.startsWith('[') ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return null
  }
  url.hash = ''
  return url.toString()
}

function cacheKey(url: string, runtimeEnvironmentId: string | null): string {
  return `${runtimeEnvironmentId ?? 'local'}:${url}`
}

async function fetchWebLinkPreview(
  url: string,
  runtimeEnvironmentId: string | null
): Promise<LinkPreview | null> {
  // A chat on a runtime environment previews from that host, like its GitHub lookups.
  const result = runtimeEnvironmentId
    ? await callRuntimeRpc<LinkPreviewResult>(
        { kind: 'environment', environmentId: runtimeEnvironmentId },
        'linkPreview.get',
        { url },
        { timeoutMs: 15_000 }
      )
    : await window.api.linkPreview.get({ url })
  return result.kind === 'page' ? result.preview : null
}

export function readCachedWebLinkPreview(
  url: string,
  runtimeEnvironmentId: string | null
): LinkPreview | null {
  return previews.read(cacheKey(url, runtimeEnvironmentId))
}

export function loadWebLinkPreview(
  url: string,
  runtimeEnvironmentId: string | null
): Promise<LinkPreview | null> {
  return previews.load(cacheKey(url, runtimeEnvironmentId), () =>
    fetchWebLinkPreview(url, runtimeEnvironmentId)
  )
}
