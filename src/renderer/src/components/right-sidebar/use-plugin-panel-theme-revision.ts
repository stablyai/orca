import { useEffect, useRef, useState, type RefObject } from 'react'
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
  // Compare baked shell values: rAF root-style writes during sidebar drags must not remount iframes and destroy panel state.
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
export function usePluginFrameThemeSync(iframeRef: RefObject<HTMLIFrameElement | null>): void {
  const revision = usePluginPanelThemeRevision()
  useEffect(() => {
    if (revision > 0) {
      postPluginFrameTheme(iframeRef.current?.contentWindow)
    }
  }, [revision, iframeRef])
}
