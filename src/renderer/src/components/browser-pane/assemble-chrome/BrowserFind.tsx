import { ImeInput } from '@/lib/ime-text-field'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getFindRequestQuery } from '@/lib/find-query-bounds'

type BrowserFindProps = {
  isOpen: boolean
  onClose: () => void
  webviewRef: React.RefObject<Electron.WebviewTag | null>
  /** Bumped whenever the pane swaps in a new guest under the same mount; rebinds the listener. */
  guestGeneration?: number | null
}

export default function BrowserFind({
  isOpen,
  onClose,
  webviewRef,
  guestGeneration = null
}: BrowserFindProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(isOpen)
  const activeFindRef = useRef<{
    query: string
    guestGeneration: number | null
    webview: Electron.WebviewTag
    requestId: number
  } | null>(null)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{
    query: string
    guestGeneration: number | null
    activeMatch: number
    totalMatches: number
  } | null>(null)
  const requestQuery = getFindRequestQuery(query)
  const currentResult =
    result?.query === requestQuery && result.guestGeneration === guestGeneration ? result : null
  const activeMatch = currentResult?.activeMatch ?? 0
  const totalMatches = currentResult?.totalMatches ?? 0

  const safeFindInPage = useCallback(
    (text: string, opts?: Electron.FindInPageOptions): void => {
      const webview = webviewRef.current
      if (!webview || !text) {
        return
      }
      try {
        const requestId = webview.findInPage(text, opts)
        activeFindRef.current = { query: text, guestGeneration, webview, requestId }
      } catch {
        // Ignore guest teardown races during navigation or tab close.
      }
    },
    [webviewRef, guestGeneration]
  )

  const safeStopFindInPage = useCallback((): void => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    try {
      webview.stopFindInPage('clearSelection')
    } catch {
      // Why: same teardown race as safeFindInPage.
    }
  }, [webviewRef])

  // Electron findNext:true starts a new session; advancing the current selection requires false.
  const isCurrentFind = useCallback(
    (): boolean =>
      activeFindRef.current?.query === requestQuery &&
      activeFindRef.current.guestGeneration === guestGeneration &&
      activeFindRef.current.webview === webviewRef.current,
    [requestQuery, guestGeneration, webviewRef]
  )

  const findNext = useCallback(() => {
    if (requestQuery) {
      const findNext = !isCurrentFind()
      safeFindInPage(requestQuery, { forward: true, findNext })
    }
  }, [requestQuery, safeFindInPage, isCurrentFind])

  const findPrevious = useCallback(() => {
    if (requestQuery) {
      const findNext = !isCurrentFind()
      safeFindInPage(requestQuery, { forward: false, findNext })
    }
  }, [requestQuery, safeFindInPage, isCurrentFind])

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      safeStopFindInPage()
    }
  }, [isOpen, safeStopFindInPage])

  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = isOpen
    if (!isOpen) {
      activeFindRef.current = null
      return
    }
    if (!requestQuery) {
      activeFindRef.current = null
      safeStopFindInPage()
      return
    }

    // A reopen or a changed query starts a fresh session, so findNext must be true here.
    const runFind = (): void => {
      if (isCurrentFind()) {
        return
      }
      safeFindInPage(requestQuery, { findNext: true })
    }
    if (!wasOpen) {
      runFind()
      return
    }
    // Debounce typing to avoid highlight flashes; reopening and Enter still use the live query.
    const id = window.setTimeout(runFind, 200)
    return () => window.clearTimeout(id)
  }, [isOpen, requestQuery, safeFindInPage, safeStopFindInPage, isCurrentFind])

  // Rebind on generation changes: client-hosted restart swaps the guest without remounting or closing Find.
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !isOpen) {
      return
    }
    const handleFoundInPage = (event: Electron.FoundInPageEvent): void => {
      const activeFind = activeFindRef.current
      if (
        !activeFind ||
        activeFind.webview !== webview ||
        activeFind.guestGeneration !== guestGeneration ||
        activeFind.requestId !== event.result.requestId
      ) {
        return
      }
      const { activeMatchOrdinal, matches } = event.result
      setResult({
        query: activeFind.query,
        guestGeneration,
        activeMatch: activeMatchOrdinal,
        totalMatches: matches
      })
    }
    webview.addEventListener('found-in-page', handleFoundInPage)
    return () => {
      try {
        webview.removeEventListener('found-in-page', handleFoundInPage)
      } catch {
        // Why: webview may be destroyed during cleanup.
      }
    }
  }, [webviewRef, isOpen, guestGeneration])

  if ((!isOpen || !requestQuery) && result !== null) {
    setResult(null)
  }

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation()

      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Enter' && e.shiftKey) {
        findPrevious()
      } else if (e.key === 'Enter') {
        findNext()
      }
    },
    [onClose, findNext, findPrevious]
  )

  if (!isOpen) {
    return null
  }

  return (
    <div
      className="absolute top-2 right-2 z-50 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/95 px-2 py-1 shadow-lg backdrop-blur-sm"
      style={{ width: 300 }}
      onKeyDown={handleKeyDown}
    >
      <ImeInput
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={translate(
          'auto.components.browser.pane.BrowserFind.636a69cd66',
          'Find in page...'
        )}
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-zinc-500"
      />

      {/* Why: a pending request has no count yet; blank avoids flashing "No matches". */}
      {query && (currentResult !== null || !requestQuery) ? (
        <span className="shrink-0 text-xs text-zinc-400">
          {totalMatches > 0
            ? translate(
                'auto.components.browser.pane.BrowserFind.fc63f336aa',
                '{{value0}} of {{value1}}',
                { value0: activeMatch, value1: totalMatches }
              )
            : translate('auto.components.browser.pane.BrowserFind.7baca7b1b8', 'No matches')}
        </span>
      ) : null}

      <div className="mx-0.5 h-4 w-px bg-zinc-700" />

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={findPrevious}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title={translate('auto.components.browser.pane.BrowserFind.ca7aebbd7f', 'Previous match')}
      >
        <ChevronUp size={14} />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={findNext}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title={translate('auto.components.browser.pane.BrowserFind.5c0c02ae76', 'Next match')}
      >
        <ChevronDown size={14} />
      </Button>

      <div className="mx-0.5 h-4 w-px bg-zinc-700" />

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title={translate('auto.components.browser.pane.BrowserFind.c9d5f63fdc', 'Close')}
      >
        <X size={14} />
      </Button>
    </div>
  )
}
