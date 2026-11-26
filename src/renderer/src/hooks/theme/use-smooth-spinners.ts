import { useEffect } from 'react'

/** Syncs the opt-in smooth spinner preference onto `:root[data-smooth-spinners]` for `main.css`. */
export function useSmoothSpinners(enabled: boolean | undefined): void {
  const smooth = enabled === true

  useEffect(() => {
    const root = document.documentElement
    if (smooth) {
      root.dataset.smoothSpinners = ''
    } else {
      delete root.dataset.smoothSpinners
    }
  }, [smooth])
}
