import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getFindRequestQuery } from '@/lib/find-query-bounds'

type BrowserFindProps = {
  isOpen: boolean
  onClose: () => void
  webviewRef: React.RefObject<Electron.WebviewTag | null>
}

export default function BrowserFind({
  isOpen,
  onClose,
  webviewRef
}: BrowserFindProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(isOpen)
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [totalMatches, setTotalMatches] = useState(0)
  const requestQuery = getFindRequestQuery(query)

  const safeFindInPage = useCallback(
    (text: string, opts?: Electron.FindInPageOptions): void => {
      const webview = webviewRef.current
      if (!webview || !text) {
        return
      }
      try {
        webview.findInPage(text, opts)
      } catch {
        // Why: the webview can be mid-teardown during tab close or navigation
        // races. Best-effort is better than crashing.
      }
    },
    [webviewRef]
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

  const findNext = useCallback(() => {
    if (requestQuery) {
      safeFindInPage(requestQuery, { forward: true, findNext: true })
    }
  }, [requestQuery, safeFindInPage])

  const findPrevious = useCallback(() => {
    if (requestQuery) {
      safeFindInPage(requestQuery, { forward: false, findNext: true })
    }
  }, [requestQuery, safeFindInPage])

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
      return
    }
    if (!requestQuery) {
      safeStopFindInPage()
      return
    }

    const runFind = (): void => safeFindInPage(requestQuery)
    if (!wasOpen) {
      runFind()
      return
    }
    // Why: findInPage re-highlights the active match on every call, which can
    // flash while typing. Debounce typing changes, while reopen and Enter
    // navigation still use the live query immediately.
    const id = window.setTimeout(runFind, 200)
    return () => window.clearTimeout(id)
  }, [isOpen, requestQuery, safeFindInPage, safeStopFindInPage])

  // Why: this effect captures `webviewRef.current` into a local variable, so
  // if the webview element were replaced while `isOpen` stays true the listener
  // would be on a stale node. This is safe because BrowserPane closes the find
  // bar (`setFindOpen(false)`) on every full navigation (`did-navigate`) and on
  // tab deactivation, which toggles `isOpen` and re-runs this effect.
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || !isOpen) {
      return
    }
    const handleFoundInPage = (event: Electron.FoundInPageEvent): void => {
      const { activeMatchOrdinal, matches } = event.result
      setActiveMatch(activeMatchOrdinal)
      setTotalMatches(matches)
    }
    webview.addEventListener('found-in-page', handleFoundInPage)
    return () => {
      try {
        webview.removeEventListener('found-in-page', handleFoundInPage)
      } catch {
        // Why: webview may be destroyed during cleanup.
      }
    }
  }, [webviewRef, isOpen])

  if ((!isOpen || !requestQuery) && (activeMatch !== 0 || totalMatches !== 0)) {
    setActiveMatch(0)
    setTotalMatches(0)
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
      <input
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

      {query ? (
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
