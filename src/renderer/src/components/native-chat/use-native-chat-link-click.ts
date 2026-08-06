import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import {
  openTerminalHttpLink,
  type TerminalLinkRoutingPreferenceRequester
} from '@/components/terminal-pane/terminal-url-link-hit-testing'
import { useLinkRoutingPreferenceRequester } from '@/hooks/useLinkRoutingPreferenceRequester'
import { useAppStore } from '../../store'
import {
  findTerminalTabWorktreeId,
  resolveNativeChatFileLink,
  resolveNativeChatFileLinkContext,
  type NativeChatFileLinkContext
} from './native-chat-file-link'

type NativeChatLinkClickContext = {
  fileContext: NativeChatFileLinkContext | null
  worktreeId: string | null
  runtimeEnvironmentId: string | null
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
}

/** Routes native-chat file and web links through the owning workspace policies. */
export function handleNativeChatLinkClick(
  event: Parameters<CommentMarkdownLinkClickHandler>[0],
  href: Parameters<CommentMarkdownLinkClickHandler>[1],
  context: NativeChatLinkClickContext
): void {
  const { fileContext, worktreeId, runtimeEnvironmentId, requestOpenLinksInAppPreference } = context
  const fileTarget = resolveNativeChatFileLink(href, fileContext)
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

  const route = routeNativeChatHref(href)
  if (route.kind !== 'web' || !/^https?:/i.test(route.url) || !worktreeId) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  openTerminalHttpLink(route.url, {
    worktreeId,
    sourceOwner: runtimeEnvironmentId
      ? { kind: 'runtime', runtimeEnvironmentId }
      : { kind: 'local' },
    modifierHeld: event.shiftKey,
    requestOpenLinksInAppPreference
  })
}

/** Binds native-chat link routing to its terminal tab and runtime owner. */
export function useNativeChatLinkClick(
  terminalTabId: string,
  runtimeEnvironmentId: string | null
): { onLinkClick: CommentMarkdownLinkClickHandler | undefined; allowFileUriLinks: boolean } {
  const requestOpenLinksInAppPreference = useLinkRoutingPreferenceRequester()
  const fileContext = useAppStore(
    useShallow((state) => resolveNativeChatFileLinkContext(state, terminalTabId))
  )
  const worktreeId = useAppStore((state) =>
    findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  )
  const openLink = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) =>
      handleNativeChatLinkClick(event, href, {
        fileContext,
        worktreeId,
        runtimeEnvironmentId,
        requestOpenLinksInAppPreference
      }),
    [fileContext, requestOpenLinksInAppPreference, runtimeEnvironmentId, worktreeId]
  )

  return {
    onLinkClick: fileContext || worktreeId ? openLink : undefined,
    allowFileUriLinks: fileContext !== null
  }
}
