import { useState, type MouseEvent } from 'react'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { handleNativeChatWebLink } from '@/components/native-chat/native-chat-web-link-actions'
import { resolveNativeChatHttpLinkRouting } from '@/components/native-chat/native-chat-link-target-actions'
import { nativeChatPlainLinkClickBehavior } from '@/components/native-chat/native-chat-link-click-behavior'
import { useAppStore } from '@/store'

export function useWorkspaceReferenceLinkActions(
  workspaceId: string | undefined,
  closeHover: () => void
) {
  const [linkActionRequest, setLinkActionRequest] = useState<LinkActionRequest | null>(null)
  const onOpenLink = (url: string, event: MouseEvent): void => {
    if (!workspaceId) {
      event.preventDefault()
      event.stopPropagation()
      void window.api.shell.openUrl(url)
      closeHover()
      return
    }
    const state = useAppStore.getState()
    const anchor = event.currentTarget
    const plainClickBehavior = nativeChatPlainLinkClickBehavior(state.settings)
    handleNativeChatWebLink(event, url, {
      worktreeId: workspaceId,
      ...resolveNativeChatHttpLinkRouting(state, workspaceId),
      actionsEnabled: plainClickBehavior === 'actions',
      plainClickBehavior,
      restoreFocus: () => {
        if (anchor instanceof HTMLElement && anchor.isConnected) {
          anchor.focus({ preventScroll: true })
        }
      },
      request: setLinkActionRequest
    })
    closeHover()
  }
  return { linkActionRequest, onOpenLink, closeLinkActions: () => setLinkActionRequest(null) }
}
