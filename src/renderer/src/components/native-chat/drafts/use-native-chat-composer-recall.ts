import { useEffect, useState, type RefObject } from 'react'
import { useNativeChatViewMemory } from '../pane/ownership/native-chat-view-memory'
import type { NativeChatComposerInput } from '../composer/editor/native-chat-composer-input'
import {
  isNativeChatRecallActive,
  type NativeChatComposerRecall,
  type NativeChatRecallPosition,
  type NativeChatRecallSource
} from './native-chat-sent-prompt-history'

// Kept with the chat tab beside the draft it recalled, so a released chat still steps through history.
const KEPT_RECALL_SCOPES = 4

/** End recall after any draft change once the recalled text has actually appeared in the composer. */
export function useNativeChatRecallPosition(
  draft: string,
  /** The composer's draft scope; without one the position stays with the view. */
  scopeKey?: string
): [NativeChatRecallPosition | null, (position: NativeChatRecallPosition | null) => void] {
  const kept = useNativeChatViewMemory<NativeChatRecallPosition>(
    scopeKey === undefined ? undefined : `recall:${scopeKey}`,
    KEPT_RECALL_SCOPES
  )
  const [position, setPosition] = useState<NativeChatRecallPosition | null>(
    () => kept.saved ?? null
  )
  // Separate stores can render position before draft; only an already-shown position may end on mismatch.
  const [shown, setShown] = useState<NativeChatRecallPosition | null>(null)
  // A scope change mid-view takes the new scope's own kept position, so the old one is never kept under it; the
  // old position isn't checked against the new scope's draft, or its mismatch would clear the new one.
  const [positionScope, setPositionScope] = useState(scopeKey)
  const scopeChanged = positionScope !== scopeKey
  if (scopeChanged) {
    setPositionScope(scopeKey)
    setPosition(kept.saved ?? null)
    setShown(null)
  }
  const { write: keep } = kept
  useEffect(() => keep(position ?? undefined), [keep, position])
  if (scopeChanged) {
    return [kept.saved ?? null, setPosition]
  }
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
  scopeKey?: string
}): { recall: NativeChatComposerRecall | undefined; active: boolean } {
  const { draft, source, inputRef, scopeKey } = args
  const [position, setPosition] = useNativeChatRecallPosition(draft, scopeKey)
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
