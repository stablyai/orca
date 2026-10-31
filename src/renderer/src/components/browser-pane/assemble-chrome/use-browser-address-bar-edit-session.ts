import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { toDisplayUrl } from '../describe-page/browser-page-url-display'
import {
  consumeBrowserAddressBarEditSession,
  type BrowserAddressBarEditSession,
  type BrowserAddressBarPreview,
  type BrowserAddressBarSelection
} from './browser-address-bar-edit-session'

/** The suggestion-list state a resumed edit reopens in. */
export type BrowserAddressBarResumedChrome = {
  suggestionsOpen: boolean
  preview: BrowserAddressBarPreview | null
}

/** What a pane hands its address bar so an interrupted edit is saved and picked back up. */
export type BrowserAddressBarEditSessionBinding = {
  pageId: string
  /** Null when this mount starts a fresh bar rather than resuming one. */
  resumed: BrowserAddressBarResumedChrome | null
}

/** Preserve draft, caret and suggestions across runtime-placement pane swaps; generation-only guest replacement keeps the same chrome mount. */
export function useBrowserAddressBarEditSession({
  pageId,
  url,
  addressBarInputRef,
  startAddressBarFocusGrab
}: {
  pageId: string
  /** The page's committed URL; the bar follows it whenever the user is not mid-edit. */
  url: string
  addressBarInputRef: RefObject<HTMLInputElement | null>
  startAddressBarFocusGrab: (selection?: BrowserAddressBarSelection) => () => void
}): {
  addressBarValue: string
  setAddressBarValue: (value: string) => void
  /** Writes the page's own URL into the bar, unless the user is typing in it. */
  setAddressBarValueFromPage: (value: string) => void
  addressBarEditSession: BrowserAddressBarEditSessionBinding
} {
  const [addressBarValue, setAddressBarValue] = useState(() => toDisplayUrl(url))
  const [resumed, setResumed] = useState<BrowserAddressBarResumedChrome | null>(null)
  const resumedPageIdRef = useRef<string | null>(null)
  const resumedSelectionRef = useRef<BrowserAddressBarSelection | null>(null)
  const pendingCaretRef = useRef<BrowserAddressBarEditSession | null>(null)

  const setAddressBarValueFromPage = useCallback(
    (next: string): void => {
      if (document.activeElement === addressBarInputRef.current) {
        return
      }
      setAddressBarValue(next)
    },
    [addressBarInputRef]
  )

  // Resume and latch focus in layout before guest attach can focus the page or overwrite the draft with its URL.
  useLayoutEffect(() => {
    // Consume once per mount; StrictMode’s intermediate save still holds the pre-resume value and must not overwrite the draft.
    if (resumedPageIdRef.current !== pageId) {
      resumedPageIdRef.current = pageId
      const session = consumeBrowserAddressBarEditSession(pageId)
      // Clear missing selections so a later page cannot inherit the prior caret.
      resumedSelectionRef.current = session?.selection ?? null
      if (session) {
        pendingCaretRef.current = session
        setAddressBarValue(session.draft)
        setResumed({ suggestionsOpen: session.suggestionsOpen, preview: session.preview })
      }
    }
    const selection = resumedSelectionRef.current
    if (!selection) {
      return
    }
    // Restart the focus grab after StrictMode cleanup cancels it; startAddressBarFocusGrab supersedes any previous grab.
    startAddressBarFocusGrab(selection)
  }, [pageId, startAddressBarFocusGrab])

  // Restore the caret once more after React commits the resumed value, then stop touching edits the user continues typing.
  useLayoutEffect(() => {
    const pending = pendingCaretRef.current
    if (!pending || pending.draft !== addressBarValue) {
      return
    }
    pendingCaretRef.current = null
    const input = addressBarInputRef.current
    if (!input || document.activeElement !== input) {
      return
    }
    input.setSelectionRange(
      pending.selection.start,
      pending.selection.end,
      pending.selection.direction
    )
  }, [addressBarInputRef, addressBarValue])

  useEffect(() => {
    setAddressBarValueFromPage(toDisplayUrl(url))
  }, [setAddressBarValueFromPage, url])

  return {
    addressBarValue,
    setAddressBarValue,
    setAddressBarValueFromPage,
    addressBarEditSession: useMemo(() => ({ pageId, resumed }), [pageId, resumed])
  }
}
