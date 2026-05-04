// Why: isolated module so the store slice can call revokeCustomSidekickBlobUrl
// without importing useSidekickUrl (which itself imports the store). Keeps
// the dependency graph acyclic.

// Why: sandbox=true + webSecurity=true block the renderer from reading user
// files directly. For custom sidekick images we fetch the bytes over IPC and
// turn them into a `blob:` URL that an <img> tag can load. A small in-memory
// cache means switching back and forth between images in the same session
// doesn't re-fetch from main.
export const blobUrlCache = new Map<string, string>()

export async function loadCustomBlobUrl(
  id: string,
  fileName: string,
  mimeType: string
): Promise<string | null> {
  const cached = blobUrlCache.get(id)
  if (cached) {
    return cached
  }
  const buffer = await window.api.sidekick.read(id, fileName)
  if (!buffer) {
    return null
  }
  // Why: MIME comes from CustomSidekick.mimeType — required especially for
  // SVG, which browsers refuse to render from a blob URL with the wrong
  // Content-Type.
  const blob = new Blob([buffer], { type: mimeType })
  const url = URL.createObjectURL(blob)
  blobUrlCache.set(id, url)
  return url
}

// Why: the store invokes this on removeCustomSidekick so the underlying Blob
// is released; otherwise the blob: URL keeps it alive for the rest of the
// session, wasting memory per imported image.
export function revokeCustomSidekickBlobUrl(id: string): void {
  const url = blobUrlCache.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    blobUrlCache.delete(id)
  }
}
