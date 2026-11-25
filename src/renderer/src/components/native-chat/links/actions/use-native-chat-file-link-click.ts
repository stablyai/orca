import { useCallback, type RefObject } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { openDetectedFilePath } from '@/components/terminal-pane/links/files/terminal-file-open-routing'
import { isTerminalLinkActionActivation } from '@/components/terminal-pane/links/gestures/terminal-link-activation'
import { useAppStore } from '../../../../store/index'
import { routeNativeChatHref } from '../../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { resolveNativeChatFileLink } from './native-chat-file-link'
import { basename } from '@/lib/path'
import { filePreviewForPath } from '../../../../../../shared/file-preview/file-preview-kind'
import { openNativeChatVideoNotes } from '../../media/notes/video/native-chat-video-notes-request'
import type { NativeChatFileLinkContext } from './native-chat-file-link-context'
import { nativeChatPlainLinkClickBehavior } from './native-chat-link-click-behavior'
import { showFileLinkUnresolvedToast } from './native-chat-file-link-toasts'
import {
  nativeChatFileLinkActions,
  nativeChatFileOpenDeps
} from './native-chat-link-target-actions'

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
      const target = resolveNativeChatFileLink(href, context)
      if (!target) {
        showFileLinkUnresolvedToast(route.pathText)
        return
      }
      const anchor = event.currentTarget
      const openInEditor = (): void =>
        openDetectedFilePath(target.absolutePath, target.line, target.column, {
          ...nativeChatFileOpenDeps(target, context),
          openWithSystemDefault: event.shiftKey
        })
      // A video on this computer opens where notes can be made on its frames.
      const openVideo =
        !event.shiftKey &&
        context.runtimeEnvironmentId === null &&
        filePreviewForPath(target.absolutePath)?.kind === 'video'
          ? (): void =>
              openNativeChatVideoNotes({
                path: target.absolutePath,
                title: basename(target.absolutePath),
                opener: anchor,
                openInEditor
              })
          : null
      if (behavior === 'open' || !request) {
        const open = openVideo ?? openInEditor
        open()
        return
      }
      // A keyboard-activated link has no pointer position; anchor under the link instead.
      const keyboardAnchor = event.detail === 0 ? anchor.getBoundingClientRect() : null
      const actions = nativeChatFileLinkActions(target, context)
      request({
        anchorX: keyboardAnchor?.left ?? event.clientX,
        anchorY: keyboardAnchor?.bottom ?? event.clientY,
        restoreFocus: () =>
          (anchor.isConnected ? anchor : rootRef?.current)?.focus({ preventScroll: true }),
        ...actions,
        ...(openVideo ? { primary: { ...actions.primary, run: openVideo } } : {})
      })
    },
    [context, request, rootRef]
  )
  return context ? openFileLink : undefined
}
