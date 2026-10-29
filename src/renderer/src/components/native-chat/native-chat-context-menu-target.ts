import type { FileLinkActions } from '@/components/terminal-pane/terminal-file-link-actions'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { nativeChatLinkActions } from './native-chat-link-target-actions'
import { readNativeChatQuotableSelection } from './native-chat-quote-selection'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'

export type NativeChatContextMenuTarget = {
  /** The selection the "Add to chat" offer would quote. */
  quoteText: string | null
  link: FileLinkActions | null
  codeText: string | null
  messageText: string | null
  rewindItemId: string | null
}

export const noNativeChatContextMenuTarget: NativeChatContextMenuTarget = {
  quoteText: null,
  link: null,
  codeText: null,
  messageText: null,
  rewindItemId: null
}

export type NativeChatContextMenuTargetSources = {
  root: HTMLElement | null
  composer: Pick<NativeChatComposerHandle, 'acceptsText'> | null
  messageList: Pick<NativeChatMessageListHandle, 'messageCopyText'> | null
  linkContext: NativeChatFileLinkContext | null
}

/** Rows mark themselves with ids only; their text comes from the transcript the rows draw. */
export function readNativeChatContextMenuTarget(
  target: EventTarget | null,
  { root, composer, messageList, linkContext }: NativeChatContextMenuTargetSources
): NativeChatContextMenuTarget {
  const element = target instanceof Element ? target : null
  const quotable = root && composer?.acceptsText() ? readNativeChatQuotableSelection(root) : null
  // The attribute, not the resolved `href` property, which rewrites chat file links into page URLs.
  const link = element?.closest('a[href], [data-native-chat-link-href]')
  const href = link?.getAttribute('data-native-chat-link-href') ?? link?.getAttribute('href')
  const messageId = element
    ?.closest('[data-native-chat-message-id]')
    ?.getAttribute('data-native-chat-message-id')
  return {
    quoteText: quotable?.text ?? null,
    link: href ? nativeChatLinkActions(href, linkContext) : null,
    codeText:
      element
        ?.closest('[data-native-chat-code-block]')
        ?.querySelector('[data-native-chat-code-content]')?.textContent || null,
    messageText: (messageId && messageList?.messageCopyText(messageId)) || null,
    rewindItemId:
      element
        ?.closest('[data-native-chat-rewind-item]')
        ?.getAttribute('data-native-chat-rewind-item') ?? null
  }
}
