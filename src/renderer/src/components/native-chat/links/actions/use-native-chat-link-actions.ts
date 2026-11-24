import { useCallback, useState, type RefObject } from 'react'
import {
  closeLinkActionRequest,
  type LinkActionRequest
} from '@/components/link-actions/link-action-request'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { routeNativeChatHref } from '../../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { useAppStore } from '../../../../store/index'
import type { NativeChatFileLinkContext } from './native-chat-file-link-context'
import { resolveNativeChatHttpLinkRouting } from './native-chat-link-target-actions'
import { handleNativeChatWebLink } from './native-chat-web-link-actions'
import {
  httpLinkModeForLink,
  plainClickDestinationsFor,
  usesHttpLinkMode
} from '@/lib/links/preferences/http-link-mode'
import { nativeChatPlainLinkClickBehavior } from './native-chat-link-click-behavior'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'

export type NativeChatLinkActions = {
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
  linkActionRequest: LinkActionRequest | null
  /** Shows the popover for a click this hook's own context did not handle. */
  requestLinkActions: (request: LinkActionRequest) => void
  closeLinkActions: (dismissed?: LinkActionRequest) => void
}

/** Match terminal destination popovers: files open in Orca/default app, HTTP(S) links in a browser. */
export function useNativeChatLinkActions(
  context: NativeChatFileLinkContext | null,
  rootRef: RefObject<HTMLElement | null>,
  scope: {
    sessionId: string | null
    isVisible: boolean
    /** Off for Markdown surfaces (bot item comments and descriptions), which keep today's routing in stage 1. */
    followsLinkMode?: boolean
  }
): NativeChatLinkActions {
  const [linkActionRequest, setLinkActionRequest] = useState<LinkActionRequest | null>(null)
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

  const onLinkClick = useNativeChatLinkClick(
    context,
    setLinkActionRequest,
    rootRef,
    scope.followsLinkMode !== false
  )
  return {
    onLinkClick,
    linkActionRequest,
    requestLinkActions: setLinkActionRequest,
    closeLinkActions
  }
}

/** One transcript's link clicks; `request` shows the shared destination popover. A group room
 *  has one popover and a link context per member, so it calls this once per member. */
export function useNativeChatLinkClick(
  context: NativeChatFileLinkContext | null,
  request: (request: LinkActionRequest) => void,
  rootRef: RefObject<HTMLElement | null>,
  followsLinkMode = true
): CommentMarkdownLinkClickHandler | undefined {
  const openFileLink = useNativeChatFileLinkClick(context, request, rootRef)
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
      const anchor = event.currentTarget
      const routed = resolveNativeChatHttpLinkRouting(state, context.worktreeId, route.url)
      const desktopMode =
        followsLinkMode && usesHttpLinkMode()
          ? httpLinkModeForLink(state.settings, routed.destinations)
          : null
      const routing = desktopMode
        ? {
            ...routed,
            destinations: plainClickDestinationsFor(routed.destinations)
          }
        : routed
      // Desktop chat follows the link mode, so effective "leave to terminal" no longer blocks it.
      const plainClickBehavior = desktopMode
        ? undefined
        : nativeChatPlainLinkClickBehavior(state.settings)
      handleNativeChatWebLink(event, route.url, {
        worktreeId: context.worktreeId,
        sourceTabId: context.sourceTabId,
        ...routing,
        actionsEnabled: desktopMode ? desktopMode === 'ask' : plainClickBehavior === 'actions',
        ...(plainClickBehavior ? { plainClickBehavior } : {}),
        ...(desktopMode ? { rememberHost: { mode: desktopMode } } : {}),
        restoreFocus: () =>
          (anchor.isConnected ? anchor : rootRef.current)?.focus({ preventScroll: true }),
        request
      })
    },
    [context, followsLinkMode, openFileLink, request, rootRef]
  )

  return context ? onLinkClick : undefined
}
