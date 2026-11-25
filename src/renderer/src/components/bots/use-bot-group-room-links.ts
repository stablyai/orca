import { useCallback, type RefObject } from 'react'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { routeNativeChatHref } from '../../../../shared/native-chat/file-access/native-chat-href-routing'
import type { NativeChatLinkContextResolver } from '../native-chat/pane/actions/native-chat-context-menu-target'
import type { NativeChatFileLinkContext } from '../native-chat/links/actions/native-chat-file-link-context'

/** What a member turn needs to send its links through the room's one popover. */
export type BotGroupRoomLinks = {
  /** The room's own handler: web links open from the room's tab, whoever wrote them. */
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
  request: (request: LinkActionRequest) => void
  rootRef: RefObject<HTMLElement | null>
}

/** A member's file paths are relative to that bot's folder; everything else belongs to the room. */
export function useBotGroupLinkContextFor(
  fileContexts: ReadonlyMap<string, { fileLinkContext: NativeChatFileLinkContext }>,
  roomContext: NativeChatFileLinkContext | null
): NativeChatLinkContextResolver {
  return useCallback<NativeChatLinkContextResolver>(
    (href, link) => {
      const botId =
        routeNativeChatHref(href).kind === 'file'
          ? link.closest('[data-group-bot]')?.getAttribute('data-group-bot')
          : null
      return botId ? (fileContexts.get(botId)?.fileLinkContext ?? null) : roomContext
    },
    [fileContexts, roomContext]
  )
}
