import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import type { BrowserExtensionToolbarState } from '../../../../../shared/browser-extension-toolbar-types'

/**
 * The extension buttons main reports for one browser page, or null when the page's session runs
 * no extensions (route, SSH and doc-preview pages) or the experimental setting is off.
 *
 * Why refetch on `pageKey`: a page's guest registers with main a moment after mount, and a
 * navigation can reset tab-scoped badges; main only pushes "this profile changed".
 */
export function useBrowserExtensionToolbar(
  browserPageId: string,
  isActive: boolean,
  pageKey: string
): BrowserExtensionToolbarState | null {
  const enabled = useAppStore((s) => s.settings?.experimentalBrowserExtensions === true)
  const [state, setState] = useState<{
    browserPageId: string
    value: BrowserExtensionToolbarState | null
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const live = enabled && isActive

  useEffect(() => {
    const subscribe = window.api.browser?.onExtensionsToolbarChanged
    if (!live || !subscribe) {
      return
    }
    return subscribe(() => setRevision((value) => value + 1))
  }, [live])

  useEffect(() => {
    const request = window.api.browser?.extensionsToolbarState
    if (!live || !request) {
      return
    }
    let cancelled = false
    void request({ browserPageId })
      .then((value) => {
        if (!cancelled) {
          setState({ browserPageId, value })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [browserPageId, live, pageKey, revision])

  // Why keep the last answer while hidden: the cluster must not blink out and back on every
  // tab switch; a hidden page just stops refetching until it is active again.
  return enabled && state?.browserPageId === browserPageId ? state.value : null
}
