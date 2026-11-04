import { useEffect, useRef, useState } from 'react'
import type { PluginFrameWindow } from './plugin-frame-host'
import {
  buildPanelDesignTokenCss,
  currentPanelColorScheme,
  postPluginFrameTheme
} from './plugin-panel-design-token-css'

function readPanelThemeSnapshot(): string {
  return `${currentPanelColorScheme()}|${buildPanelDesignTokenCss()}`
}

export function usePluginPanelThemeRevision(): number {
  const [revision, setRevision] = useState(0)
  // Compare baked shell values: unrelated root-style writes must not remount iframes and destroy panel state.
  const snapshotRef = useRef<string | null>(null)
  useEffect(() => {
    snapshotRef.current ??= readPanelThemeSnapshot()
    const observer = new MutationObserver(() => {
      const snapshot = readPanelThemeSnapshot()
      if (snapshot === snapshotRef.current) {
        return
      }
      snapshotRef.current = snapshot
      setRevision((current) => current + 1)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    })
    return () => observer.disconnect()
  }, [])
  return revision
}

/** Pushes theme changes into a plugin frame without remounting it. */
export function usePluginFrameThemeSync(getFrameWindow: () => PluginFrameWindow | null): void {
  const revision = usePluginPanelThemeRevision()
  useEffect(() => {
    if (revision > 0) {
      postPluginFrameTheme(getFrameWindow())
    }
  }, [revision, getFrameWindow])
}
