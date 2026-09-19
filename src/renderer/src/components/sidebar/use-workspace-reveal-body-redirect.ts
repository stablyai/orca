import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT } from '@/lib/scroll-to-current-workspace-status'

/**
 * Reveal requests (rename shortcut, reveal-active-workspace button) are handled inside the
 * worktree list, which is unmounted while the Agents body is showing. Capture the request,
 * switch the body to Spaces, and replay it once the list's listener is registered.
 */
export function useWorkspaceRevealBodyRedirect(agentsBodyShowing: boolean): void {
  const pendingDetailRef = useRef<{ detail: unknown } | null>(null)
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)

  useEffect(() => {
    if (!agentsBodyShowing) {
      return
    }
    const onRequest = (event: Event): void => {
      pendingDetailRef.current = { detail: event instanceof CustomEvent ? event.detail : undefined }
      setSidebarBody('workspaces')
    }
    window.addEventListener(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, onRequest)
    return () => {
      window.removeEventListener(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, onRequest)
    }
  }, [agentsBodyShowing, setSidebarBody])

  useEffect(() => {
    if (agentsBodyShowing) {
      return
    }
    const pending = pendingDetailRef.current
    if (!pending) {
      return
    }
    pendingDetailRef.current = null
    // Why safe to replay synchronously: the worktree list is a child of the sidebar, so its
    // listener effect ran earlier in this same commit.
    window.dispatchEvent(
      new CustomEvent(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, { detail: pending.detail })
    )
  }, [agentsBodyShowing])
}
