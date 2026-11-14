import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ComposerAutocomplete } from '../../../../../../shared/native-chat/input/native-chat-composer-autocomplete'
import { preferredNativeChatPickerIndex } from '../../../../../../shared/native-chat/input/native-chat-picker-items'

/** Highlight the best name match after every edit or caret move; arrow keys own it in between.
 * Returns the setter for user navigation, which pins the highlight until the next edit. */
export function useNativeChatPreferredSuggestion(
  autocomplete: ComposerAutocomplete,
  draft: string,
  caret: number,
  setActiveSuggestion: Dispatch<SetStateAction<number>>
): Dispatch<SetStateAction<number>> {
  const slash = autocomplete.mode === 'slash' ? autocomplete : null
  // Why draft+caret, not just query: edits that keep the query (e.g. deleting text after it) still reset the highlight to 0.
  const editKey = slash && `${caret}\0${draft}`
  const rowKey = slash ? slash.items.map((item) => item.id).join('\0') : ''
  const preferredIndex = slash ? preferredNativeChatPickerIndex(slash.items, slash.query) : 0
  const shownRef = useRef<{ editKey: string; rowIds: string[] } | null>(null)
  const navigatedRef = useRef(false)
  // Why layout: the edit handlers reset the highlight to 0, and this replaces it before the menu paints.
  useLayoutEffect(() => {
    const prev = shownRef.current
    if (editKey === null) {
      shownRef.current = null
      navigatedRef.current = false
      return
    }
    const rowIds = rowKey.split('\0')
    shownRef.current = { editKey, rowIds }
    if (prev?.editKey !== editKey) {
      navigatedRef.current = false
      setActiveSuggestion(preferredIndex)
      return
    }
    // Rows changed with no edit (a catalog refresh): keep a row the user arrowed to, else follow the best match.
    setActiveSuggestion((current) => {
      const kept = navigatedRef.current ? rowIds.indexOf(prev.rowIds[current]) : -1
      return kept === -1 ? preferredIndex : kept
    })
  }, [editKey, rowKey, preferredIndex, setActiveSuggestion])

  return useCallback(
    (action: SetStateAction<number>) => {
      navigatedRef.current = true
      setActiveSuggestion(action)
    },
    [setActiveSuggestion]
  )
}
