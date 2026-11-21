import { useLayoutEffect, type RefObject } from 'react'
import { createNativeChatReplyTarget, setNativeChatReplyTarget } from './native-chat-reply-target'
import { nativeChatPrimaryComposer } from '../focus/native-chat-composer-destination'

export type NativeChatReplySource = {
  messageId: string
  author: 'agent' | 'user'
  text: string
}

/** Points the chat's message box at `source` and hands the user back to typing there. Does nothing
 *  while the box is not shown (a question card answers instead); a queued-message editor never takes it. */
export function startNativeChatReply(from: Element | null, source: NativeChatReplySource): boolean {
  const root = from?.closest<HTMLElement>('[data-native-chat-root]') ?? null
  const composer = nativeChatPrimaryComposer(root)
  if (!composer) {
    return false
  }
  setNativeChatReplyTarget(composer.scopeKey, createNativeChatReplyTarget(source))
  composer.handle.focus()
  return true
}

/** A message jump the transcript answers when it holds that message; `found` reports whether it did. */
const REVEAL_MESSAGE_EVENT = 'native-chat:reveal-message'
/** Fired on the chat root when the transcript's messages change, so availability is asked again. */
export const NATIVE_CHAT_MESSAGES_CHANGED_EVENT = 'native-chat:messages-changed'
/** The message a reply answers: its id, or for a reply restored from sent text, its author and words. */
export type NativeChatRevealMessage = {
  messageId: string
  author: 'agent' | 'user'
  excerpt: string
}
type RevealMessageDetail = {
  message: NativeChatRevealMessage
  probe: boolean
  found: string | null
}

/** Each chat's latest jump; an older one still waiting for its row must not land after it. */
const latestReveal = new WeakMap<Element, number>()
let revealSequence = 0

/** With `probe`, only asks whether the transcript holds the message; `focus` moves focus to it once it lands. */
export function requestNativeChatMessageReveal(
  from: Element | null,
  message: NativeChatRevealMessage,
  options: { probe: boolean; focus?: boolean }
): boolean {
  const root = from?.closest('[data-native-chat-root]')
  if (!root) {
    return false
  }
  const detail: RevealMessageDetail = { message, probe: options.probe, found: null }
  root.dispatchEvent(new CustomEvent(REVEAL_MESSAGE_EVENT, { detail }))
  if (detail.found && !options.probe) {
    revealSequence += 1
    latestReveal.set(root, revealSequence)
    markNativeChatRevealedMessage(root, detail.found, options.focus === true, revealSequence)
  }
  return detail.found !== null
}

const LANDED_MS = 1500
/** Each row's pending outline removal, so jumping to it again gives the new outline its full time. */
const landedTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
const LANDING_FRAMES = 60

/** Once the jumped-to row is drawn: outline it briefly and move focus there, so keyboard and screen-reader users land too. */
function markNativeChatRevealedMessage(
  root: Element,
  messageId: string,
  focus: boolean,
  request: number,
  frame = 0
): void {
  if (latestReveal.get(root) !== request) {
    return
  }
  const row = root.querySelector<HTMLElement>(
    `[data-native-chat-message-id="${CSS.escape(messageId)}"]`
  )
  if (!row) {
    if (frame < LANDING_FRAMES) {
      requestAnimationFrame(() =>
        markNativeChatRevealedMessage(root, messageId, focus, request, frame + 1)
      )
    }
    return
  }
  row.setAttribute('data-native-chat-reply-landed', '')
  // Keyboard users land on the message; a mouse click keeps the caret in the message box.
  if (focus) {
    if (!row.hasAttribute('tabindex')) {
      row.tabIndex = -1
    }
    row.focus({ preventScroll: true })
  }
  clearTimeout(landedTimers.get(row))
  landedTimers.set(
    row,
    setTimeout(() => row.removeAttribute('data-native-chat-reply-landed'), LANDED_MS)
  )
}

/** The transcript's side: answers reveal requests in its chat. Layout-time, so a strip's
 *  passive probe on the same commit already finds it. */
export function useNativeChatMessageRevealAnswer(
  scrollRef: RefObject<HTMLElement | null>,
  reveal: ((message: NativeChatRevealMessage, probe: boolean) => string | null) | null
): void {
  useLayoutEffect(() => {
    const root = scrollRef.current?.closest('[data-native-chat-root]')
    if (!root || !reveal) {
      return
    }
    const onReveal = (event: Event): void => {
      const detail: RevealMessageDetail | undefined =
        event instanceof CustomEvent ? event.detail : undefined
      if (detail && !detail.found) {
        detail.found = reveal(detail.message, detail.probe)
      }
    }
    root.addEventListener(REVEAL_MESSAGE_EVENT, onReveal)
    // `reveal` changes with the transcript's messages; anything showing availability asks again.
    root.dispatchEvent(new Event(NATIVE_CHAT_MESSAGES_CHANGED_EVENT))
    return () => {
      root.removeEventListener(REVEAL_MESSAGE_EVENT, onReveal)
      // The transcript leaving (an empty, loading or error view) is a change too.
      root.dispatchEvent(new Event(NATIVE_CHAT_MESSAGES_CHANGED_EVENT))
    }
  }, [reveal, scrollRef])
}
