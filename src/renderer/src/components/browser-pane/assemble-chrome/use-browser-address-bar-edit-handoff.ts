import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { saveBrowserAddressBarEditSession } from './browser-address-bar-edit-session'
import type { BrowserAddressBarEditSessionBinding } from './use-browser-address-bar-edit-session'

/**
 * The bar's half of an edit session: hands an in-progress edit to whatever mounts next for the
 * same page, and puts the suggestion list back the way a handed-on edit left it.
 */
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
    // Why after the fact rather than as the initial state: the pane resumes in its own layout
    // effect, which runs after this bar has already mounted (and after the focus it takes has
    // opened the dropdown the way a fresh click would). This is what puts it back as the user
    // left it. Re-arming the blur grace window keeps the resumed focus from closing it again.
    if (resumedChrome.preview) {
      prePreviewValueRef.current = resumedChrome.preview.typedQuery
      setSelectedValueOverride(resumedChrome.preview.previewedUrl)
    }
    openedAtRef.current = Date.now()
    setOpen(resumedChrome.suggestionsOpen)
  }, [openedAtRef, prePreviewValueRef, resumedChrome, setOpen, setSelectedValueOverride])

  // Why layout and not a passive cleanup: React destroys passive effects for a deleted tree after
  // its DOM is gone, and by then document.activeElement is the body — every edit would read idle.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!editSessionPageId || !input) {
      return
    }
    return () => {
      // Why only a focused bar: an idle one has no edit to hand on, and resuming it would seize
      // focus and reopen a dropdown for a user who was reading the page.
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
        // Why the draft alone is not enough: mid-preview it holds the highlighted suggestion, and
        // dropping this would strand the user with no way back to what they actually typed.
        preview:
          typedQuery === null || inlineTyped !== null
            ? null
            : { typedQuery, previewedUrl: liveEditRef.current.value }
      })
    }
  }, [editSessionPageId, inputRef, prePreviewValueRef])
}
