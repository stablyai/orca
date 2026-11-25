// What the item view does to its comment box from outside it: focus it, type or put words in it, or
// put a held answer back in it with its images and skills.
import { useImperativeHandle, type Ref, type RefObject } from 'react'
import type { BotItemHeldAnswer } from '../../../../../shared/bots/bot-item-held-answers'
import type { NativeChatComposerInput } from '../../native-chat/composer/editor/native-chat-composer-input'
import type { NativeChatComposerHandle } from '../../native-chat/composer/native-chat-composer-types'
import { readNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { composerQuoteTarget } from '../../native-chat/selection-quotes/NativeChatSelectionQuote'
import type { BotItemReplyMark } from './BotItemReplyingTo'
import { returnBotItemHeldAnswer } from './bot-item-held-answers'

export type BotItemCommentBoxHandle = ReturnType<typeof composerQuoteTarget> & {
  focus: () => void
  /** Focus the box with the caret after its text, as when coming back to a draft. */
  focusEnd: () => void
  /** Focus the box and type `text` at its caret. */
  type: (text: string) => void
  /** Put `text` in the box in place of its words, to add to before sending; `plain`: as a comment
   *  of its own, with "Replying to" hidden; else as the answer, naming the question. */
  fill: (text: string, plain?: boolean) => void
  /** Put a held answer back after the box's words, its images and skills too, as chat hands back a
   *  message it didn't send; `plain` as for `fill`. */
  restore: (answer: BotItemHeldAnswer, plain?: boolean) => void
  /** Focus the box to answer the waiting question in your own words: it glows once, naming it. */
  answer: () => void
}

/** The box's handle; returns its caret-to-end, which a click in its padding uses too. */
export function useBotItemCommentBoxHandle(
  ref: Ref<BotItemCommentBoxHandle> | undefined,
  {
    scopeKey,
    input,
    composer,
    reply,
    setDraft
  }: {
    scopeKey: string
    input: RefObject<NativeChatComposerInput | null>
    composer: RefObject<NativeChatComposerHandle | null>
    reply: BotItemReplyMark
    setDraft: (next: string) => void
  }
): () => void {
  const caretToEnd = (): void => {
    const node = input.current
    node?.focus()
    node?.setSelectionRange(node.value.length, node.value.length)
  }
  // Shows `text` at once, ahead of the store's next render; `plain` hides "Replying to".
  const show = (text: string, plain: boolean | undefined): void => {
    const mark = plain ? reply.hide : reply.show
    mark()
    if (input.current) {
      input.current.value = text
    }
    caretToEnd()
  }
  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    focusEnd: caretToEnd,
    ...composerQuoteTarget(composer),
    type: (typed) => void composer.current?.insertTypedText(typed),
    answer: () => {
      reply.show()
      composer.current?.focus({ caretAtEnd: true, glow: true })
    },
    fill: (text, plain) => {
      setDraft(`${text} `)
      show(`${text} `, plain)
    },
    restore: (answer, plain) => {
      returnBotItemHeldAnswer(scopeKey, answer)
      // The editor takes the store's draft whole, its image and skill pills too.
      show(readNativeChatComposerDraft(scopeKey).text, plain)
    }
  }))
  return caretToEnd
}
