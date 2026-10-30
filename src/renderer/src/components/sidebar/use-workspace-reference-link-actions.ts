import { useState, type MouseEvent } from 'react'
import type { LinkAction, LinkActionRequest } from '@/components/link-actions/link-action-request'
import { handleNativeChatWebLink } from '@/components/native-chat/native-chat-web-link-actions'
import { resolveNativeChatHttpLinkRouting } from '@/components/native-chat/native-chat-link-target-actions'
import { nativeChatPlainLinkClickBehavior } from '@/components/native-chat/native-chat-link-click-behavior'
import { isTerminalLinkDirectActivation } from '@/components/terminal-pane/terminal-link-activation'
import { httpLinkDirectClickDestination } from '@/lib/http-link-destinations'
import { useAppStore } from '@/store'
import type { WorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { openAppHttpLink } from '@/lib/app-http-link-open'

export function useWorkspaceReferenceLinkActions(
  workspaceId: string | undefined,
  { closeHover, handleLinkActionsOpenChange, holdOpenUntilRefocus }: WorktreeCardDetailsHoverControl
) {
  const [linkActionRequest, setLinkActionRequest] = useState<LinkActionRequest | null>(null)
  // Why: only an Orca-browser open moves the user elsewhere in the app; a
  // system-browser open should leave the card where it was.
  const closeHoverOnInternalRun = (action: LinkAction): LinkAction => ({
    ...action,
    run: () => {
      if (action.external) {
        holdOpenUntilRefocus()
      } else {
        closeHover()
      }
      return action.run()
    }
  })
  const onOpenLink = (url: string, event: MouseEvent): void => {
    if (!workspaceId) {
      event.preventDefault()
      event.stopPropagation()
      holdOpenUntilRefocus()
      openAppHttpLink(url, { event })
      return
    }
    const state = useAppStore.getState()
    const anchor = event.currentTarget
    const plainClickBehavior = nativeChatPlainLinkClickBehavior(state.settings)
    const routing = resolveNativeChatHttpLinkRouting(state, workspaceId)
    let requested = false
    const consumed = handleNativeChatWebLink(event, url, {
      worktreeId: workspaceId,
      ...routing,
      actionsEnabled: plainClickBehavior === 'actions',
      plainClickBehavior,
      restoreFocus: () => {
        if (anchor instanceof HTMLElement && anchor.isConnected) {
          anchor.focus({ preventScroll: true })
        }
      },
      request: (request) => {
        requested = true
        handleLinkActionsOpenChange(true)
        setLinkActionRequest({
          ...request,
          primary: closeHoverOnInternalRun(request.primary),
          alternate: request.alternate && closeHoverOnInternalRun(request.alternate),
          secondaryActions: request.secondaryActions?.map(closeHoverOnInternalRun)
        })
      }
    })
    if (requested) {
      return
    }
    const destination = !consumed
      ? 'system'
      : isTerminalLinkDirectActivation(event)
        ? httpLinkDirectClickDestination(routing.destinations, event.shiftKey)
        : routing.destinations.primary
    if (destination === 'system') {
      holdOpenUntilRefocus()
    } else {
      closeHover()
    }
  }
  const closeLinkActions = (): void => {
    setLinkActionRequest(null)
    handleLinkActionsOpenChange(false)
  }
  const linkActionPopoverProps = {
    request: linkActionRequest,
    onClose: closeLinkActions,
    // Why: a click on the card itself only dismisses the chooser; anywhere else dismisses both.
    onPointerDownOutside: (event: Event): void => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[data-slot="hover-card-content"]')
      ) {
        closeHover()
      }
    },
    onOpenSettings: closeHover
  }
  // Why: middle-click takes the anchor's native target=_blank path to the system browser.
  const onAuxClickCapture = (event: MouseEvent): void => {
    if (event.button === 1 && event.target instanceof Element && event.target.closest('a[href]')) {
      holdOpenUntilRefocus()
    }
  }
  return { linkActionPopoverProps, onOpenLink, onAuxClickCapture }
}
