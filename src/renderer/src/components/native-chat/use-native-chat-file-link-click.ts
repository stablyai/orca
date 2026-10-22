import { useCallback, type RefObject } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { isTerminalLinkActionActivation } from '@/components/terminal-pane/terminal-link-activation'
import { useAppStore } from '../../store'
import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import { resolveNativeChatFileLink, type NativeChatFileLinkContext } from './native-chat-file-link'
import { nativeChatPlainLinkClickBehavior } from './native-chat-link-click-behavior'
import { showFileLinkUnresolvedToast } from './native-chat-file-link-toasts'
import {
  nativeChatFileLinkActions,
  nativeChatFileOpenDeps
} from './native-chat-link-target-actions'

/** A plain click offers the terminal's file popover (when that is the user's link-click
 *  setting); a modifier click opens in Orca, and Shift opens the default app. */
export function useNativeChatFileLinkClick(
  context: NativeChatFileLinkContext | null,
  request?: (request: LinkActionRequest) => void,
  rootRef?: RefObject<HTMLElement | null>
): CommentMarkdownLinkClickHandler | undefined {
  const openFileLink = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      if (!context) {
        return
      }
      const route = routeNativeChatHref(href)
      if (route.kind !== 'file') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const state = useAppStore.getState()
      const behavior = isTerminalLinkActionActivation(event)
        ? nativeChatPlainLinkClickBehavior(state.settings)
        : 'open'
      if (behavior === 'none') {
        return
      }
      const target = resolveNativeChatFileLink(href, context)
      if (!target) {
        showFileLinkUnresolvedToast(route.pathText)
        return
      }
      if (behavior === 'open' || !request) {
        openDetectedFilePath(target.absolutePath, target.line, target.column, {
          ...nativeChatFileOpenDeps(target, context),
          openWithSystemDefault: event.shiftKey
        })
        return
      }
      const anchor = event.currentTarget
      // A keyboard-activated link has no pointer position; anchor under the link instead.
      const keyboardAnchor = event.detail === 0 ? anchor.getBoundingClientRect() : null
      request({
        anchorX: keyboardAnchor?.left ?? event.clientX,
        anchorY: keyboardAnchor?.bottom ?? event.clientY,
        restoreFocus: () =>
          (anchor.isConnected ? anchor : rootRef?.current)?.focus({ preventScroll: true }),
        ...nativeChatFileLinkActions(target, context)
      })
    },
    [context, request, rootRef]
  )
  return context ? openFileLink : undefined
}
