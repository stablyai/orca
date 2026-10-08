import { useState, type RefObject } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  isNativeChatRecallActive,
  type NativeChatComposerRecall,
  type NativeChatRecallPosition,
  type NativeChatRecallSource
} from './native-chat-sent-prompt-history'

/**
 * Where prompt recall stands. Ends itself once the composer stops holding the recalled
 * text, whoever changed it: an edit, a send, a returned message, another window's draft.
 */
export function useNativeChatRecallPosition(
  draft: string
): [NativeChatRecallPosition | null, (position: NativeChatRecallPosition | null) => void] {
  const [position, setPosition] = useState<NativeChatRecallPosition | null>(null)
  // Why: the position and its draft come from different stores and may not render together,
  // so only a position already seen in the composer can be ended by a mismatch.
  const [shown, setShown] = useState<NativeChatRecallPosition | null>(null)
  if (position !== null) {
    if (position.recalled === draft) {
      if (shown !== position) {
        setShown(position)
      }
    } else if (shown === position) {
      setPosition(null)
      return [null, setPosition]
    }
  }
  return [position, setPosition]
}

/** Prompt recall for one composer: what its keydown walks, and whether the draft is a recalled
 *  prompt still untouched. Without a source there is nothing to recall. */
export function useNativeChatComposerRecall(args: {
  draft: string
  source: NativeChatRecallSource | undefined
  inputRef: RefObject<NativeChatComposerInput | null>
}): { recall: NativeChatComposerRecall | undefined; active: boolean } {
  const { draft, source, inputRef } = args
  const [position, setPosition] = useNativeChatRecallPosition(draft)
  return {
    active: isNativeChatRecallActive(position, draft),
    recall: source && {
      source,
      position,
      setPosition,
      isCaretOnVisualEdge: (edge) => inputRef.current?.isCaretOnVisualEdge?.(edge) ?? true,
      show: (prompt) => {
        const input = inputRef.current
        if (input) {
          input.value = prompt
          input.setSelectionRange(prompt.length, prompt.length)
        }
      }
    }
  }
}
