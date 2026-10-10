import { useEffect, useState } from 'react'
import { isLinuxUserAgent } from '@/components/terminal-pane/pane-helpers'
import type { OmarchyThemePalette } from '../../../shared/omarchy-theme-palette'

/** The local Omarchy palette when one is rendered; null hides every Omarchy option. */
export function useAvailableOmarchyTheme(): OmarchyThemePalette | null {
  const [palette, setPalette] = useState<OmarchyThemePalette | null>(null)

  useEffect(() => {
    // Omarchy is Linux-only; skip the IPC entirely elsewhere.
    if (!isLinuxUserAgent()) {
      return undefined
    }
    let disposed = false
    const unsubscribe = window.api.settings.onOmarchyThemeChanged(setPalette)
    void window.api.settings.readOmarchyTheme().then((next) => {
      if (!disposed) {
        setPalette((current) => current ?? next)
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return palette
}
