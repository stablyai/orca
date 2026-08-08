import { useCallback, useState } from 'react'

/**
 * Holds the composer mounted while an IME composition is in flight, so the
 * question-card swap cannot destroy the composing node.
 *
 * Why: unmounting a field mid-composition aborts the OS composition. The node
 * is detached before `compositionend` can fire, the preedit returns as
 * committed text, and a resumed Hangul syllable degrades — 아 then ㄴ yields
 * `아ㄴ`, never `안`. Editors that survive IME take this same route: ProseMirror
 * gates DOM work on `view.composing`, CodeMirror protects the composing subtree
 * from redraws.
 *
 * Hiding instead of unmounting does NOT work: `display:none` and
 * `visibility:hidden` both blur the focused element, which aborts the
 * composition exactly as the unmount does.
 *
 * The hold releases on `compositionend`, which browsers also fire on blur, so
 * clicking into the card's own answer input yields the composer immediately.
 *
 * A hold can only be set by a composer this view is already rendering, and any
 * later `compositionend` clears it, so a stale hold self-heals; its worst case
 * is a composer sitting beside a card until the next composition ends.
 */
export function useNativeChatComposerCompositionHold(questionActive: boolean): {
  renderComposer: boolean
  onCompositionActiveChange: (active: boolean) => void
} {
  const [composing, setComposing] = useState(false)

  return {
    renderComposer: !questionActive || composing,
    onCompositionActiveChange: useCallback((active: boolean) => {
      setComposing(active)
    }, [])
  }
}
