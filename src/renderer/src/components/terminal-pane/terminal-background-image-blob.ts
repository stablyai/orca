import { useEffect, useLayoutEffect, useState } from 'react'
import type { TerminalBackgroundImage } from '../../../../shared/terminal-background-image'

// Why: sandbox=true + webSecurity=true block the renderer from reading user
// files directly (same constraint as custom pet images). The bytes come over
// IPC and are exposed as a blob: URL. There is at most one active background
// image, but it can be shown by many panes and swapped at runtime, so the cache
// is keyed by image id and reference-counted by the id each pane is *currently
// displaying* — never by the requested id. That distinction is what keeps a
// replace from revoking a URL a pane is still painting.
const blobUrls = new Map<string, string>()
const refCounts = new Map<string, number>()
const pendingLoads = new Map<string, Promise<string | null>>()

// Bounds memory if a corner case leaves an entry cached with no live consumer
// (e.g. every pane unmounts while a read is still in flight).
const MAX_CACHED = 4

function releaseUnreferenced(exceptId: string): void {
  if (blobUrls.size <= MAX_CACHED) {
    return
  }
  for (const [id, url] of blobUrls) {
    if (id === exceptId || refCounts.has(id)) {
      continue
    }
    URL.revokeObjectURL(url)
    blobUrls.delete(id)
    if (blobUrls.size <= MAX_CACHED) {
      return
    }
  }
}

/** Retain the cached entry for the id a pane is displaying; the returned release
 *  revokes the blob only once the last displaying pane lets go. */
function retain(id: string): () => void {
  refCounts.set(id, (refCounts.get(id) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const next = (refCounts.get(id) ?? 1) - 1
    if (next > 0) {
      refCounts.set(id, next)
      return
    }
    refCounts.delete(id)
    const url = blobUrls.get(id)
    if (url) {
      URL.revokeObjectURL(url)
      blobUrls.delete(id)
    }
  }
}

async function loadTerminalBackgroundBlobUrl(
  image: TerminalBackgroundImage
): Promise<string | null> {
  const cached = blobUrls.get(image.id)
  if (cached) {
    return cached
  }
  const pending = pendingLoads.get(image.id)
  if (pending) {
    return pending
  }
  const load = (async (): Promise<string | null> => {
    const buffer = await window.api.terminalBackground.read(image.id, image.fileName)
    if (!buffer) {
      return null
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: image.mimeType }))
    blobUrls.set(image.id, url)
    releaseUnreferenced(image.id)
    return url
  })().finally(() => {
    if (pendingLoads.get(image.id) === load) {
      pendingLoads.delete(image.id)
    }
  })
  pendingLoads.set(image.id, load)
  return load
}

/** Resolve the configured background image to a blob: URL, or null while
 *  loading, when unset, or when the file is missing on disk. Every mounted
 *  terminal pane calls this; the module cache dedupes the IPC read and holds a
 *  reference for as long as this pane paints the resolved image. */
export function useTerminalBackgroundImageUrl(
  image: TerminalBackgroundImage | null | undefined
): string | null {
  const id = image?.id ?? null
  const fileName = image?.fileName ?? null
  const mimeType = image?.mimeType ?? null
  const [displayed, setDisplayed] = useState<{ id: string; url: string } | null>(() => {
    if (!id) {
      return null
    }
    const url = blobUrls.get(id)
    return url ? { id, url } : null
  })

  // Why: retain the entry actually on screen, not the requested id. While a
  // replacement loads, this pane still shows the previous image, so the previous
  // entry must stay retained until this pane swaps — otherwise the last release
  // of the old id would revoke a URL still in the DOM.
  useLayoutEffect(() => {
    const shownId = displayed?.id
    if (!shownId) {
      return undefined
    }
    return retain(shownId)
  }, [displayed?.id])

  useEffect(() => {
    if (!id || !fileName || !mimeType) {
      setDisplayed(null)
      return undefined
    }
    const cached = blobUrls.get(id)
    if (cached) {
      setDisplayed({ id, url: cached })
      return undefined
    }
    let cancelled = false
    void loadTerminalBackgroundBlobUrl({ id, fileName, mimeType }).then((url) => {
      if (!cancelled) {
        setDisplayed(url ? { id, url } : null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [id, fileName, mimeType])

  // Keep the last loaded image on screen until the next is ready so a replace
  // never flashes to blank; clearing the image resets this to null above.
  return displayed?.url ?? null
}
