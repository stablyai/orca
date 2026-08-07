import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import {
  resolveNativeChatFileLink,
  resolveNativeChatFileLinkContext
} from '@/components/native-chat/native-chat-file-link'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { openHttpLink } from '@/lib/http-link-routing'
import { useAppStore } from '@/store'

export type ActivityThreadLinkClickContext = {
  worktreeId: string
  tabId: string
}

// Why: the Activity thread preview mirrors terminal/native-chat link handling —
// file links switch to their worktree and open there, http links honor
// openLinksInApp and foreground the worktree hosting the browser tab.
export function createActivityThreadLinkClick(
  context: ActivityThreadLinkClickContext
): CommentMarkdownLinkClickHandler {
  return (event, href) => {
    const state = useAppStore.getState()
    const fileContext = resolveNativeChatFileLinkContext(state, context.tabId)
    const fileTarget = fileContext ? resolveNativeChatFileLink(href, fileContext) : null
    if (fileTarget && fileContext) {
      event.preventDefault()
      event.stopPropagation()
      openDetectedFilePath(fileTarget.absolutePath, fileTarget.line, fileTarget.column, {
        worktreeId: fileContext.worktreeId,
        worktreePath: fileContext.worktreePath,
        runtimeEnvironmentId: fileContext.runtimeEnvironmentId,
        openWithSystemDefault: event.shiftKey
      })
      return
    }
    const normalized = href?.trim().toLowerCase() ?? ''
    if (href && (normalized.startsWith('http:') || normalized.startsWith('https:'))) {
      event.preventDefault()
      event.stopPropagation()
      openHttpLink(href, {
        worktreeId: context.worktreeId,
        modifierHeld: event.shiftKey
      })
    }
  }
}
