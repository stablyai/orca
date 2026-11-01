import { useCallback, useState, type RefObject } from 'react'
import {
  closeLinkActionRequest,
  type LinkActionRequest
} from '@/components/link-actions/link-action-request'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { routeNativeChatHref } from '../../../../shared/native-chat/native-chat-href-routing'
import { useAppStore } from '../../store'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { resolveNativeChatHttpLinkRouting } from './native-chat-link-target-actions'
import { handleNativeChatWebLink, openNativeChatWebLink } from './native-chat-web-link-actions'
import { nativeChatPlainLinkClickBehavior } from './native-chat-link-click-behavior'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'

export type NativeChatLinkActions = {
  openUrl: ((url: string) => void) | undefined
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
  linkActionRequest: LinkActionRequest | null
  closeLinkActions: (dismissed?: LinkActionRequest) => void
}

/** Match terminal destination popovers: files open in Orca/default app, HTTP(S) links in a browser. */
export function useNativeChatLinkActions(
  context: NativeChatFileLinkContext | null,
  rootRef: RefObject<HTMLElement | null>,
  scope: { sessionId: string | null; isVisible: boolean }
): NativeChatLinkActions {
  const [linkActionRequest, setLinkActionRequest] = useState<LinkActionRequest | null>(null)
  const openFileLink = useNativeChatFileLinkClick(context, setLinkActionRequest, rootRef)
  const scopeKey = JSON.stringify([
    context?.worktreeId,
    context?.runtimeEnvironmentId,
    scope.sessionId
  ])
  const [previousScopeKey, setPreviousScopeKey] = useState(scopeKey)
  if (previousScopeKey !== scopeKey || (!scope.isVisible && linkActionRequest !== null)) {
    setPreviousScopeKey(scopeKey)
    setLinkActionRequest(null)
  }
  const closeLinkActions = useCallback((dismissed?: LinkActionRequest) => {
    setLinkActionRequest((current) => closeLinkActionRequest(current, dismissed))
  }, [])

  const onLinkClick = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      if (!context) {
        return
      }
      const route = routeNativeChatHref(href)
      if (route.kind === 'file') {
        openFileLink?.(event, href)
        return
      }
      if (route.kind !== 'web' || !/^https?:/i.test(route.url)) {
        return
      }
      // Read at click time: settings and workspace ownership must not re-render the transcript.
      const state = useAppStore.getState()
      const plainClickBehavior = nativeChatPlainLinkClickBehavior(state.settings)
      const anchor = event.currentTarget
      handleNativeChatWebLink(event, route.url, {
        worktreeId: context.worktreeId,
        sourceTabId: context.sourceTabId,
        ...resolveNativeChatHttpLinkRouting(state, context.worktreeId),
        actionsEnabled: plainClickBehavior === 'actions',
        plainClickBehavior,
        restoreFocus: () =>
          (anchor.isConnected ? anchor : rootRef.current)?.focus({ preventScroll: true }),
        request: setLinkActionRequest
      })
    },
    [context, openFileLink, rootRef]
  )

  const openUrl = useCallback(
    (url: string): void => {
      if (!context || !/^https?:/i.test(url)) {
        return
      }
      const routing = resolveNativeChatHttpLinkRouting(useAppStore.getState(), context.worktreeId)
      openNativeChatWebLink(
        url,
        {
          worktreeId: context.worktreeId,
          sourceTabId: context.sourceTabId,
          sourceOwner: routing.sourceOwner
        },
        routing.destinations.primary
      )
    },
    [context]
  )

  return {
    openUrl: context ? openUrl : undefined,
    onLinkClick: context ? onLinkClick : undefined,
    linkActionRequest,
    closeLinkActions
  }
}
