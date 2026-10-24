import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  consumeBrowserAddressBarEditSession,
  type BrowserAddressBarEditSession,
  type BrowserAddressBarPreview,
  type BrowserAddressBarSelection
} from './browser-address-bar-edit-session'
import { useBrowserAddressBarText } from './use-browser-address-bar-text'
import { useAddressBarSelectionAfterCommit } from './use-address-bar-selection-after-commit'

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
}): ReturnType<typeof useBrowserAddressBarText> & {
  addressBarEditSession: BrowserAddressBarEditSessionBinding
} {
  const text = useBrowserAddressBarText({ url, addressBarInputRef })
  const { addressBarValue, setAddressBarValue } = text
  const placeSelection = useAddressBarSelectionAfterCommit(addressBarInputRef, addressBarValue)
  const [resumed, setResumed] = useState<BrowserAddressBarResumedChrome | null>(null)
  const resumedPageIdRef = useRef<string | null>(null)
  const resumedSelectionRef = useRef<BrowserAddressBarSelection | null>(null)

  // Why layout and not passive: the client-hosted pane's guest-attach effects run in the same
  // commit, and both focusing the webview and syncing the bar to the guest's URL would undo the
  // resume. Grabbing focus here — which also raises the latch the guest-attach effect defers to —
  // settles who owns the bar before any of them look.
  useLayoutEffect(() => {
    // Why the consume is once per mount but the grab below is not: StrictMode destroys and
    // recreates this effect on a pane that never went anywhere. The bar's save runs in between, on
    // a bar this resume just focused and still holding the value the mount rendered with — reading
    // that write back is what wiped the draft.
    let session: BrowserAddressBarEditSession | null = null
    if (resumedPageIdRef.current !== pageId) {
      resumedPageIdRef.current = pageId
      session = consumeBrowserAddressBarEditSession(pageId)
      // Why cleared rather than left standing: a page id that arrives with nothing parked must not
      // inherit the previous one's caret. Today's deps make that unreachable; a future one need not.
      resumedSelectionRef.current = session?.selection ?? null
      if (session) {
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
    if (session) {
      placeSelection(session.draft, session.selection, (input) => document.activeElement === input)
    }
  }, [pageId, placeSelection, setAddressBarValue, startAddressBarFocusGrab])

  return {
    ...text,
    addressBarEditSession: useMemo(() => ({ pageId, resumed }), [pageId, resumed])
  }
}
