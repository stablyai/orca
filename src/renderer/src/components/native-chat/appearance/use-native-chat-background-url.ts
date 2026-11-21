import { useEffect, useState } from 'react'

type CachedBackground = { url: Promise<string | null>; users: number }

// Every open chat shows the same picture, so they share one blob URL.
const backgrounds = new Map<string, CachedBackground>()

async function loadBackgroundUrl(fileName: string): Promise<string | null> {
  const image = await window.api.nativeChatBackground?.read(fileName)
  return image ? URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType })) : null
}

function acquire(fileName: string): Promise<string | null> {
  let cached = backgrounds.get(fileName)
  if (!cached) {
    cached = { url: loadBackgroundUrl(fileName), users: 0 }
    backgrounds.set(fileName, cached)
  }
  cached.users += 1
  return cached.url
}

function release(fileName: string): void {
  const cached = backgrounds.get(fileName)
  if (!cached) {
    return
  }
  cached.users -= 1
  if (cached.users > 0) {
    return
  }
  backgrounds.delete(fileName)
  void cached.url.then((url) => url && URL.revokeObjectURL(url)).catch(() => {})
}

export function useNativeChatBackgroundUrl(fileName: string): string | null {
  const [loaded, setLoaded] = useState<{ fileName: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!fileName) {
      return
    }
    let active = true
    acquire(fileName)
      .then((url) => active && setLoaded({ fileName, url }))
      .catch((error) => {
        console.error('Failed to load chat background image:', error)
        if (active) {
          setLoaded({ fileName, url: null })
        }
      })
    return () => {
      active = false
      release(fileName)
    }
  }, [fileName])
  return fileName && loaded?.fileName === fileName ? loaded.url : null
}
