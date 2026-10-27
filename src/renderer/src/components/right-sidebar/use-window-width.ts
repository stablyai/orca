import { useEffect, useState } from 'react'

// Clamp persisted widths to the current window so resized/hydrated sidebars cannot cover editor/terminal content.
export function useWindowWidth(): number | null {
  const [windowWidth, setWindowWidth] = useState(() => getWindowWidth())

  useEffect(() => {
    function update(): void {
      setWindowWidth(getWindowWidth())
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return windowWidth
}

function getWindowWidth(): number | null {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerWidth)) {
    return null
  }
  return window.innerWidth
}
