import { useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { saveBrowserAddressBarEditSession } from './browser-address-bar-edit-session'
import type { BrowserAddressBarEditSessionBinding } from './use-browser-address-bar-edit-session'

export function useBrowserAddressBarEditSessionSync({
  editSession,
  value,
  open,
  inputRef,
  prePreviewValueRef,
  openedAtRef,
  setSelectedValueOverride,
  setOpen
}: {
  editSession?: BrowserAddressBarEditSessionBinding | null
  value: string
  open: boolean
  inputRef: RefObject<HTMLInputElement | null>
  prePreviewValueRef: MutableRefObject<string | null>
  openedAtRef: MutableRefObject<number>
  setSelectedValueOverride: (url: string | null) => void
  setOpen: (open: boolean) => void
}): void {
  const editSessionPageId = editSession?.pageId ?? null
  const resumedChrome = editSession?.resumed ?? null
  const liveEditRef = useRef({ value, open })

  useLayoutEffect(() => {
    liveEditRef.current = { value, open }
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
      saveBrowserAddressBarEditSession(editSessionPageId, {
        draft: liveEditRef.current.value,
        selection: {
          start: input.selectionStart ?? input.value.length,
          end: input.selectionEnd ?? input.value.length,
          direction: input.selectionDirection ?? 'none'
        },
        suggestionsOpen: liveEditRef.current.open,
        // Why the draft alone is not enough: mid-preview it holds the highlighted suggestion, and
        // dropping this would strand the user with no way back to what they actually typed.
        preview:
          typedQuery === null ? null : { typedQuery, previewedUrl: liveEditRef.current.value }
      })
    }
  }, [editSessionPageId, inputRef, prePreviewValueRef])
}
