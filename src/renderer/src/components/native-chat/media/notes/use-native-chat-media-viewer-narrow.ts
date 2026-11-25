import { useEffect, useState } from 'react'

/** Below this width the notes panel becomes a bottom sheet. */
const NARROW_WIDTH = 720

/** Whether the window is narrow enough that the notes panel is a bottom sheet. */
export function useNativeChatMediaViewerNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_WIDTH)
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW_WIDTH)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}
