import { useEffect, useState } from 'react'
import {
  acquireAppBackgroundBlobUrl,
  peekSettledAppBackgroundBlobUrl,
  type AppBackgroundImageRef
} from './app-background-blob-cache'

export type AppBackgroundBlobState =
  | { status: 'loading'; url: null }
  | { status: 'loaded'; url: string }
  | { status: 'missing'; url: null }

function toBlobState(url: string | null): AppBackgroundBlobState {
  return url ? { status: 'loaded', url } : { status: 'missing', url: null }
}

/** Load state of the image's blob URL while mounted; null when there is no image. */
export function useAppBackgroundBlobState(
  image: AppBackgroundImageRef | null
): AppBackgroundBlobState | null {
  const id = image?.id ?? null
  const staging = image?.staging === true
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null)
  const key = id ? `${staging}:${id}` : null

  useEffect(() => {
    if (!id) {
      return undefined
    }
    const ref = { id, staging }
    const effectKey = `${staging}:${id}`
    const handle = acquireAppBackgroundBlobUrl(ref)
    let active = true
    void handle.url.then((url) => {
      if (active) {
        setLoaded({ key: effectKey, url })
      }
    })
    return () => {
      active = false
      handle.release()
    }
  }, [id, staging])

  if (!id || !key) {
    return null
  }
  if (loaded?.key === key) {
    return toBlobState(loaded.url)
  }
  const settled = peekSettledAppBackgroundBlobUrl({ id, staging })
  return settled ? toBlobState(settled.url) : { status: 'loading', url: null }
}

/** Blob URL for the image while mounted; null until loaded or when unreadable. */
export function useAppBackgroundBlobUrl(image: AppBackgroundImageRef | null): string | null {
  return useAppBackgroundBlobState(image)?.url ?? null
}

export type AppBackgroundLayerProps = {
  imageId: string
  /** True for a not-yet-applied pick in userData/appearance/.staging. */
  staging?: boolean
  /** 0..1 */
  imageOpacity: number
  /** px */
  blur: number
}

/** Paints the background image behind a host carrying getAppBackgroundHostProps(); render it as the host's first child. */
export function AppBackgroundLayer({
  imageId,
  staging,
  imageOpacity,
  blur
}: AppBackgroundLayerProps): React.JSX.Element | null {
  const url = useAppBackgroundBlobUrl({ id: imageId, staging })
  if (!url) {
    return null
  }
  return (
    <div
      aria-hidden="true"
      className="app-background-layer"
      data-testid="app-background-layer"
      style={{
        backgroundImage: `url("${url}")`,
        opacity: imageOpacity,
        filter: blur > 0 ? `blur(${blur}px)` : undefined,
        // Why: blur samples transparent pixels past the edge; overscan hides the faded rim.
        inset: blur > 0 ? `${-blur * 2}px` : undefined
      }}
    />
  )
}
