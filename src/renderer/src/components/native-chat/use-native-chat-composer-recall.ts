import { useState, type RefObject } from 'react'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  isNativeChatRecallActive,
  type NativeChatComposerRecall,
  type NativeChatRecallPosition,
  type NativeChatRecallSource
} from './native-chat-sent-prompt-history'

/** End recall after any draft change once the recalled text has actually appeared in the composer. */
export function useNativeChatRecallPosition(
  draft: string
): [NativeChatRecallPosition | null, (position: NativeChatRecallPosition | null) => void] {
  const [position, setPosition] = useState<NativeChatRecallPosition | null>(null)
  // Separate stores can render position before draft; only an already-shown position may end on mismatch.
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

/** Build keydown recall only with a source, tracking whether recalled text remains untouched. */
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
