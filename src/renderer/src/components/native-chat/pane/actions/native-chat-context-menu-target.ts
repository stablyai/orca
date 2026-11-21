import type { FileLinkActions } from '@/components/terminal-pane/links/files/terminal-file-link-actions'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import type { NativeChatFileLinkContext } from '../../links/actions/native-chat-file-link-context'
import { nativeChatLinkActions } from '../../links/actions/native-chat-link-target-actions'
import { readNativeChatQuotableSelection } from '../../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import type { NativeChatMessageListHandle } from '../../messages/actions/use-native-chat-reveal-latest'
import {
  readNativeChatTranscriptRowSelection,
  type NativeChatSelectionReference as SelectionReference
} from '../../selection-quotes/native-chat-transcript-selection'

export type { NativeChatSelectionReference } from '../../selection-quotes/native-chat-transcript-selection'

/** Present only where this chat can take a selection into an auxiliary chat; presence is the capability. */
export type NativeChatAuxiliaryChat = {
  addReference: (reference: SelectionReference) => void
  /** Why the action cannot run now; null when it can. */
  referenceBlockedReason: string | null
}

export type NativeChatContextMenuTarget = {
  /** The selection the "Add to chat" offer would quote. */
  quoteText: string | null
  /** The selected row text, frozen when the menu was opened. */
  auxiliaryReference: SelectionReference | null
  link: FileLinkActions | null
  codeText: string | null
  messageText: string | null
  rewindItemId: string | null
  /** A message of the owner's posted to the chat's Slack thread, which Delete from Slack takes back. */
  slackPostedItemId: string | null
}

export const noNativeChatContextMenuTarget: NativeChatContextMenuTarget = {
  quoteText: null,
  auxiliaryReference: null,
  link: null,
  codeText: null,
  messageText: null,
  rewindItemId: null,
  slackPostedItemId: null
}

export type NativeChatLinkContextResolver = (
  href: string,
  link: Element
) => NativeChatFileLinkContext | null

export function hasNativeChatContextTarget(target: NativeChatContextMenuTarget): boolean {
  return Boolean(
    target.quoteText ??
    target.auxiliaryReference ??
    target.link ??
    target.codeText ??
    target.messageText
  )
}

export type NativeChatContextMenuTargetSources = {
  root: HTMLElement | null
  composer: Pick<NativeChatComposerHandle, 'acceptsText'> | null
  messageList: Partial<Pick<NativeChatMessageListHandle, 'messageCopyText'>> | null
  linkContext: NativeChatFileLinkContext | null | NativeChatLinkContextResolver
}

/** Rows mark their stable identity; text comes from the selection or the transcript they draw. */
export function readNativeChatContextMenuTarget(
  target: EventTarget | null,
  { root, composer, messageList, linkContext }: NativeChatContextMenuTargetSources
): NativeChatContextMenuTarget {
  const element = target instanceof Element ? target : null
  const quotable = root && composer?.acceptsText() ? readNativeChatQuotableSelection(root) : null
  const selectedRow = root ? readNativeChatTranscriptRowSelection(root) : null
  // The attribute, not the resolved `href` property, which rewrites chat file links into page URLs.
  const link = element?.closest('a[href], [data-native-chat-link-href]')
  const href = link?.getAttribute('data-native-chat-link-href') ?? link?.getAttribute('href')
  const messageId = element
    ?.closest('[data-native-chat-message-id]')
    ?.getAttribute('data-native-chat-message-id')
  return {
    quoteText: quotable?.text ?? null,
    auxiliaryReference: selectedRow
      ? { sourceRowId: selectedRow.sourceRowId, text: selectedRow.text }
      : null,
    link:
      href && link
        ? nativeChatLinkActions(
            href,
            typeof linkContext === 'function' ? linkContext(href, link) : linkContext
          )
        : null,
    codeText:
      element
        ?.closest('[data-native-chat-code-block]')
        ?.querySelector('[data-native-chat-code-content]')?.textContent || null,
    messageText: (messageId && messageList?.messageCopyText?.(messageId)) || null,
    rewindItemId:
      element
        ?.closest('[data-native-chat-rewind-item]')
        ?.getAttribute('data-native-chat-rewind-item') ?? null,
    slackPostedItemId:
      element
        ?.closest('[data-native-chat-slack-posted]')
        ?.getAttribute('data-native-chat-slack-posted') ?? null
  }
}
