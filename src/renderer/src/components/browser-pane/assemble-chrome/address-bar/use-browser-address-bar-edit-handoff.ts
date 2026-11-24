import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { saveBrowserAddressBarEditSession } from './browser-address-bar-edit-session'
import type { BrowserAddressBarEditSessionBinding } from './use-browser-address-bar-edit-session'

/** Carry a live edit and suggestion-list state to the replacement bar for the same page. */
export function useBrowserAddressBarEditHandoff({
  editSession,
  inputRef,
  prePreviewValueRef,
  openedAtRef,
  setSelectedValueOverride,
  setOpen,
  live
}: {
  editSession: BrowserAddressBarEditSessionBinding | null | undefined
  inputRef: RefObject<HTMLInputElement | null>
  /** The typed text while the bar shows a previewed or inline-completed suggestion. */
  prePreviewValueRef: MutableRefObject<string | null>
  openedAtRef: MutableRefObject<number>
  setSelectedValueOverride: (url: string | null) => void
  setOpen: (open: boolean) => void
  live: { value: string; open: boolean; inlineShown: boolean }
}): void {
  const editSessionPageId = editSession?.pageId ?? null
  const resumedChrome = editSession?.resumed ?? null
  const liveEditRef = useRef(live)
  useLayoutEffect(() => {
    liveEditRef.current = live
  })

  useLayoutEffect(() => {
    if (!resumedChrome) {
      return
    }
    // Restore after the pane’s layout resume reopens suggestions through focus; rearm blur grace to preserve the saved chrome state.
    if (resumedChrome.preview) {
      prePreviewValueRef.current = resumedChrome.preview.typedQuery
      setSelectedValueOverride(resumedChrome.preview.previewedUrl)
    }
    openedAtRef.current = Date.now()
    setOpen(resumedChrome.suggestionsOpen)
  }, [openedAtRef, prePreviewValueRef, resumedChrome, setOpen, setSelectedValueOverride])

  // Save in layout cleanup before DOM removal; passive cleanup would see body focus and lose the edit.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!editSessionPageId || !input) {
      return
    }
    return () => {
      // Only focused bars have edits to resume; idle bars must not seize focus or reopen suggestions.
      if (document.activeElement !== input) {
        return
      }
      const typedQuery = prePreviewValueRef.current
      // Why: an inline completion is not kept across a remount, so hand on what was typed.
      const inlineTyped = liveEditRef.current.inlineShown ? typedQuery : null
      saveBrowserAddressBarEditSession(editSessionPageId, {
        draft: inlineTyped ?? liveEditRef.current.value,
        selection:
          inlineTyped !== null
            ? { start: inlineTyped.length, end: inlineTyped.length, direction: 'none' }
            : {
                start: input.selectionStart ?? input.value.length,
                end: input.selectionEnd ?? input.value.length,
                direction: input.selectionDirection ?? 'none'
              },
        suggestionsOpen: liveEditRef.current.open,
        // During preview the draft holds a suggestion URL; retain the separate typed query for Escape.
        preview:
          typedQuery === null || inlineTyped !== null
            ? null
            : { typedQuery, previewedUrl: liveEditRef.current.value }
      })
    }
  }, [editSessionPageId, inputRef, prePreviewValueRef])
}
