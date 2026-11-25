import { useEffect, useState } from 'react'
import { userNamedFileAccess } from '@/lib/files/access/local-file-access'

/** A playable URL for a local video the user opened from a chat: the media scheme streams it by
 *  range. `failed` once it can't be read (moved, deleted, not reachable from here). */
export function useNativeChatVideoSrc(path: string | null): {
  src: string | null
  failed: boolean
} {
  const [state, setState] = useState<{ path: string; src: string | null; failed: boolean } | null>(
    null
  )
  useEffect(() => {
    if (!path) {
      return
    }
    let live = true
    const settle = (src: string | null): void => {
      if (live) {
        setState({ path, src, failed: !src })
      }
    }
    window.api.fs
      .readFile({ filePath: path, access: userNamedFileAccess(), rangePreview: true })
      .then((result) => settle(result.mediaUrl ?? null))
      .catch(() => settle(null))
    return () => {
      live = false
    }
  }, [path])
  return state && state.path === path
    ? { src: state.src, failed: state.failed }
    : { src: null, failed: false }
}
