import { useEffect, useState } from 'react'

// Why: persisted right-sidebar widths can outlive the window size they were
// chosen in. Clamp from the current window so the terminal/editor never render
// underneath the sidebar after resize or hydration.
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
