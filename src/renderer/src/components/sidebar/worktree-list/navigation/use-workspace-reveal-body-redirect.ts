import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT } from '@/lib/scroll-to-current-workspace-status'

/** Capture reveal requests while the list is unmounted (sidebar closed or Agents showing); show Spaces and replay after the listener mounts. */
export function useWorkspaceRevealBodyRedirect(listHidden: boolean): void {
  const pendingDetailRef = useRef<{ detail: unknown } | null>(null)
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)

  useEffect(() => {
    if (!listHidden) {
      return
    }
    const onRequest = (event: Event): void => {
      pendingDetailRef.current = {
        detail: event instanceof CustomEvent ? event.detail : undefined
      }
      setSidebarOpen(true)
      setSidebarBody('workspaces')
    }
    window.addEventListener(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, onRequest)
    return () => {
      window.removeEventListener(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, onRequest)
    }
  }, [listHidden, setSidebarBody, setSidebarOpen])

  useEffect(() => {
    if (listHidden) {
      return
    }
    const pending = pendingDetailRef.current
    if (!pending) {
      return
    }
    pendingDetailRef.current = null
    // Child list effects install its listener before this parent effect replays the request.
    window.dispatchEvent(
      new CustomEvent(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, {
        detail: pending.detail
      })
    )
  }, [listHidden])
}
