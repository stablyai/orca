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

/**
 * The address bar's draft text, and its continuity across a remount.
 *
 * Panes that host a runtime page get swapped under React: adopting a client-hosted placement
 * replaces the streamed pane with the client-hosted one, and a host restart bumps the key of the
 * client-hosted one. Either way the chrome unmounts, and without this the user's half-typed URL,
 * caret and open suggestion list go with it.
 */
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

  // Why layout and not passive: the client-hosted pane's guest-attach effects run in the same
  // commit, and both focusing the webview and syncing the bar to the guest's URL would undo the
  // resume. Grabbing focus here — which also raises the latch the guest-attach effect defers to —
  // settles who owns the bar before any of them look.
  useLayoutEffect(() => {
    // Why the consume is once per mount but the grab below is not: StrictMode destroys and
    // recreates this effect on a pane that never went anywhere. The bar's save runs in between, on
    // a bar this resume just focused and still holding the value the mount rendered with — reading
    // that write back is what wiped the draft.
    if (resumedPageIdRef.current !== pageId) {
      resumedPageIdRef.current = pageId
      const session = consumeBrowserAddressBarEditSession(pageId)
      // Why cleared rather than left standing: a page id that arrives with nothing parked must not
      // inherit the previous one's caret. Today's deps make that unreachable; a future one need not.
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
    // Why the grab sits outside that branch: the teardown on the way through a rebuild cancels
    // whatever grab is in flight, so a grab fired only on the consume leaves the rebuilt pane with
    // nothing holding the bar, and its guest-attach effect takes focus to the page. Re-firing needs
    // no canceller held here — startAddressBarFocusGrab cancels the previous grab itself.
    startAddressBarFocusGrab(selection)
  }, [pageId, startAddressBarFocusGrab])

  // Why the caret is placed twice: the grab above puts it back against the value still on screen,
  // and React then resets a focused input's selection as it commits the resumed draft. This is the
  // commit that lands it — and the only one, so nothing keeps re-aiming a bar the user is typing in.
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
