import { useCallback } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import { resolveNativeChatFileLink, type NativeChatFileLinkContext } from './native-chat-file-link'
import {
  showFileLinkNotFoundToast,
  showFileLinkUnresolvedToast,
  showFileLinkUnverifiableToast
} from './native-chat-file-link-toasts'

export function useNativeChatFileLinkClick(
  context: NativeChatFileLinkContext | null
): CommentMarkdownLinkClickHandler | undefined {
  const openFileLink = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      if (!context) {
        return
      }
      const target = resolveNativeChatFileLink(href, context)
      if (!target) {
        const route = routeNativeChatHref(href)
        if (route.kind === 'file') {
          // Why: e.g. `~/x` when the home folder cannot be inferred; never a dead click.
          event.preventDefault()
          showFileLinkUnresolvedToast(route.pathText)
        }
        return
      }
      event.preventDefault()
      event.stopPropagation()
      openDetectedFilePath(target.absolutePath, target.line, target.column, {
        worktreeId: context.worktreeId,
        worktreePath: context.worktreePath,
        runtimeEnvironmentId: context.runtimeEnvironmentId,
        openWithSystemDefault: event.shiftKey,
        // Why: an underlined link must answer every click, so a miss says why.
        onOpenFailure: (failure) =>
          failure.verdict === 'unverifiable'
            ? showFileLinkUnverifiableToast(target.absolutePath, failure.error)
            : showFileLinkNotFoundToast(target.absolutePath)
      })
    },
    [context]
  )
  return context ? openFileLink : undefined
}
