import { useCallback, useEffect, useRef } from 'react'

// A panel draws a handful of images; the cap only bounds a plugin that cycles through many.
const MAX_CACHED_IMAGES = 64

/**
 * Object URLs for a components panel's plugin images, read by main inside the plugin. One read per
 * path per session; every URL is revoked when the session changes or the panel closes.
 */
export function usePluginDeclarativeImages(
  sessionToken: string | null
): (path: string) => Promise<string | null> {
  const cache = useRef(new Map<string, Promise<string | null>>())
  useEffect(() => {
    const entries = cache.current
    return () => {
      for (const pending of entries.values()) {
        void pending.then((url) => url && URL.revokeObjectURL(url))
      }
      entries.clear()
    }
  }, [sessionToken])
  return useCallback(
    (path: string) => {
      const known = cache.current.get(path)
      if (known) {
        return known
      }
      const read = window.api?.plugins?.panelImage
      if (!sessionToken || !read || cache.current.size >= MAX_CACHED_IMAGES) {
        return Promise.resolve(null)
      }
      const pending = read({ sessionToken, path })
        .then((image) =>
          // Copied: a Blob needs bytes backed by a plain ArrayBuffer.
          image
            ? URL.createObjectURL(
                new Blob([new Uint8Array(image.bytes)], { type: image.contentType })
              )
            : null
        )
        .catch(() => null)
      cache.current.set(path, pending)
      return pending
    },
    [sessionToken]
  )
}
