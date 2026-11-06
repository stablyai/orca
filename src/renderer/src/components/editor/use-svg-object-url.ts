import { useEffect, useState } from 'react'

/** A blob URL drawing the markup as an image, so its scripts never run and its ids stay isolated. */
export function useSvgObjectUrl(markup: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (markup === null) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [markup])
  return url
}
