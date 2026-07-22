// Asset storage for collab boards.
//
// tldraw requires an asset store: when the operator pastes an image onto a
// board, something has to decide where those bytes live. tldraw's own
// Cloudflare template puts them in R2. Our sync sidecar has no asset endpoint
// yet, so this inlines small assets as data URIs, which travel inside the
// document and therefore reach every device through sync with no extra service.
//
// This is a real limit, not a stub: data URIs are base64 (~33% overhead) and
// live in the synced document forever, so a large paste would bloat the doc for
// every client. The cap below refuses those loudly instead of quietly making
// every board slow. A proper upload endpoint on the sidecar is the follow-up.

import type { TLAssetStore } from 'tldraw'

/** Refuse anything past this inline. Chosen so a screenshot or a phone photo
 *  paste works, while a video or a huge PNG is rejected with an explanation
 *  rather than silently degrading every client's sync payload. */
export const MAX_INLINE_ASSET_BYTES = 2 * 1024 * 1024

export class CollabCanvasAssetTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(
      `Asset is ${Math.round(bytes / 1024)}KB; boards inline assets and cap them at ` +
        `${MAX_INLINE_ASSET_BYTES / 1024 / 1024}MB until the sync server gains an upload endpoint.`
    )
    this.name = 'CollabCanvasAssetTooLargeError'
  }
}

export function createInlineAssetStore(
  maxBytes: number = MAX_INLINE_ASSET_BYTES
): TLAssetStore {
  return {
    async upload(_asset, file) {
      if (file.size > maxBytes) {
        throw new CollabCanvasAssetTooLargeError(file.size)
      }
      const buffer = await file.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buffer)
      // Chunked so a multi-MB asset does not blow the argument limit of
      // String.fromCharCode via a single spread.
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      const src = `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`
      return { src }
    },
    // The asset src IS the data URI, so resolution is the identity function.
    resolve(asset) {
      return asset.props.src ?? null
    }
  }
}
