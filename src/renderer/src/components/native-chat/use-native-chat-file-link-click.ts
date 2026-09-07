import { useCallback } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { resolveNativeChatFileLink, type NativeChatFileLinkContext } from './native-chat-file-link'

export function useNativeChatFileLinkClick(
  context: NativeChatFileLinkContext | null
): CommentMarkdownLinkClickHandler | undefined {
  const openFileLink = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      const target = resolveNativeChatFileLink(href, context)
      if (!target || !context) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      openDetectedFilePath(target.absolutePath, target.line, target.column, {
        worktreeId: context.worktreeId,
        worktreePath: context.worktreePath,
        runtimeEnvironmentId: context.runtimeEnvironmentId,
        openWithSystemDefault: event.shiftKey
      })
    },
    [context]
  )
  return context ? openFileLink : undefined
}
