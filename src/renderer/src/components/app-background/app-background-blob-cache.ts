import { getAppBackgroundImageMimeType } from '../../../../shared/app-background-settings'

// Why: sandbox + webSecurity block file:// reads, so bytes come over IPC and render from a blob: URL.
// Ref-counted so the live layer and a settings preview share one URL, revoked when the last user leaves.

export type AppBackgroundImageRef = { id: string; staging?: boolean }

type Entry = {
  refs: number
  url: string | null
  /** True once the read finished; with url still null the image is missing or unreadable. */
  settled: boolean
  load: Promise<string | null>
}

const entries = new Map<string, Entry>()

export function getAppBackgroundBlobKey(image: AppBackgroundImageRef): string {
  return `${image.staging ? 'staging' : 'saved'}:${image.id}`
}

/** Null while nobody holds the image or its read is still in flight. */
export function peekSettledAppBackgroundBlobUrl(
  image: AppBackgroundImageRef
): { url: string | null } | null {
  const entry = entries.get(getAppBackgroundBlobKey(image))
  return entry?.settled ? { url: entry.url } : null
}

async function loadBlobUrl(image: AppBackgroundImageRef): Promise<string | null> {
  const mimeType = getAppBackgroundImageMimeType(image.id)
  if (!mimeType) {
    return null
  }
  const bytes = await window.api.appBackground.read({ id: image.id, staging: image.staging })
  // Why: the web preload stub resolves undefined instead of bytes.
  if (!bytes) {
    return null
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
}

/** Retains the image's blob URL; call the returned release exactly once when done. */
export function acquireAppBackgroundBlobUrl(image: AppBackgroundImageRef): {
  url: Promise<string | null>
  release: () => void
} {
  const key = getAppBackgroundBlobKey(image)
  let entry = entries.get(key)
  if (!entry) {
    const created: Entry = { refs: 0, url: null, settled: false, load: Promise.resolve(null) }
    created.load = loadBlobUrl(image)
      .catch((err: unknown) => {
        console.warn('Failed to load background image:', err)
        return null
      })
      .then((url) => {
        if (entries.get(key) !== created) {
          // Released before the bytes arrived.
          if (url) {
            URL.revokeObjectURL(url)
          }
          return null
        }
        created.url = url
        created.settled = true
        return url
      })
    entries.set(key, created)
    entry = created
  }
  const retained = entry
  retained.refs += 1
  let released = false
  return {
    url: retained.load,
    release: () => {
      if (released) {
        return
      }
      released = true
      retained.refs -= 1
      if (retained.refs > 0 || entries.get(key) !== retained) {
        return
      }
      entries.delete(key)
      if (retained.url) {
        URL.revokeObjectURL(retained.url)
      }
    }
  }
}
