import { useCallback, useMemo, type RefObject } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { openDetectedFilePath } from '@/components/terminal-pane/links/files/terminal-file-open-routing'
import type { ExplicitFileOpenDestination } from '@/components/terminal-pane/links/files/terminal-file-open-failure'
import { isHtmlFilePath } from '@/components/terminal-pane/links/files/local-html-file-destinations'
import { canShowWorkspaceFileBrowserAction } from '@/lib/browser/documents/file-preview'
import type { AppState } from '@/store/types'
import { isTerminalLinkActionActivation } from '@/components/terminal-pane/links/gestures/terminal-link-activation'
import { useAppStore } from '../../../../store/index'
import { routeNativeChatHref } from '../../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { resolveNativeChatFileLink } from './native-chat-file-link'
import type { NativeChatFileLinkContext } from './native-chat-file-link-context'
import { nativeChatPlainLinkClickBehavior } from './native-chat-link-click-behavior'
import {
  showFileLinkUnresolvedToast,
  showFileOrcaBrowserOpenFailureToast
} from './native-chat-file-link-toasts'
import {
  nativeChatFileLinkActions,
  nativeChatFileOpenDeps
} from './native-chat-link-target-actions'

/** An explicit open button's actions on chat file hrefs; undefined where the chat cannot open files. */
export type NativeChatFileOpener = {
  worktreeId: string
  /** The chat's working directory, which file names are shown relative to. */
  worktreePath: string
  /** The href's absolute path in this chat's workspace, or null when it does not resolve. */
  resolvePath: (href: string) => string | null
  /** Where an explicit open of the href goes right now: a page the Orca Browser can show, else the editor. */
  destinationFor: (href: string) => ExplicitFileOpenDestination
  /** Opens at exactly `destination`, ignoring link-click settings; a browser failure toasts, never the editor. */
  open: (href: string, options: { destination: ExplicitFileOpenDestination }) => void
}

export function nativeChatExplicitFileDestination(
  state: AppState,
  worktreeId: string,
  absolutePath: string
): ExplicitFileOpenDestination {
  // Mirror the router: only .html/.htm go to a browser, and only where this workspace can show one.
  return isHtmlFilePath(absolutePath) &&
    canShowWorkspaceFileBrowserAction(state, worktreeId, absolutePath)
    ? 'orca-browser'
    : 'editor'
}

function createNativeChatExplicitFileOpener(
  context: NativeChatFileLinkContext
): NativeChatFileOpener {
  return {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    resolvePath: (href) => resolveNativeChatFileLink(href, context)?.absolutePath ?? null,
    destinationFor: (href) => {
      const target = resolveNativeChatFileLink(href, context)
      return target
        ? nativeChatExplicitFileDestination(
            useAppStore.getState(),
            context.worktreeId,
            target.absolutePath
          )
        : 'editor'
    },
    open: (href, { destination }) =>
      openNativeChatFileHref(href, context, { explicitDestination: destination })
  }
}

export function useNativeChatExplicitFileOpener(
  context: NativeChatFileLinkContext | null
): NativeChatFileOpener | undefined {
  return useMemo(
    () => (context ? createNativeChatExplicitFileOpener(context) : undefined),
    [context]
  )
}

function openNativeChatFileHref(
  href: string | undefined,
  context: NativeChatFileLinkContext,
  options: { openWithSystemDefault?: boolean; explicitDestination?: ExplicitFileOpenDestination }
): void {
  const route = routeNativeChatHref(href)
  if (route.kind !== 'file') {
    return
  }
  const target = resolveNativeChatFileLink(href, context)
  if (!target) {
    showFileLinkUnresolvedToast(route.pathText)
    return
  }
  openDetectedFilePath(target.absolutePath, target.line, target.column, {
    ...nativeChatFileOpenDeps(target, context),
    openWithSystemDefault: options.openWithSystemDefault ?? false,
    ...(options.explicitDestination
      ? {
          explicitDestination: options.explicitDestination,
          onBrowserOpenFailure: () => showFileOrcaBrowserOpenFailureToast(target.absolutePath)
        }
      : {})
  })
}

/** Honor terminal link-click settings: plain-click popover, modifier opens in Orca, Shift uses the default app. */
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
      if (behavior === 'open' || !request) {
        openNativeChatFileHref(href, context, { openWithSystemDefault: event.shiftKey })
        return
      }
      const target = resolveNativeChatFileLink(href, context)
      if (!target) {
        showFileLinkUnresolvedToast(route.pathText)
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
