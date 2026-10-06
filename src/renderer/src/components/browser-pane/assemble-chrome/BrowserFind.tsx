import { ImeInput } from '@/lib/ime-text-field'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getFindRequestQuery } from '@/lib/find-query-bounds'
import type { BrowserPageSurface } from '../host-guest/browser-page-surface'
import { useNativeViewOcclusionRef } from '@/hooks/useNativeViewOcclusion'

type BrowserFindProps = {
  isOpen: boolean
  onClose: () => void
  surface: BrowserPageSurface
  /** Bumped whenever the pane swaps in a new guest under the same mount; rebinds the listener. */
  guestGeneration?: number | null
}

export default function BrowserFind({
  isOpen,
  onClose,
  surface,
  guestGeneration = null
}: BrowserFindProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const occlusionRef = useNativeViewOcclusionRef<HTMLDivElement>()
  const wasOpenRef = useRef(isOpen)
  const activeFindQueryRef = useRef<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [totalMatches, setTotalMatches] = useState(0)
  const requestQuery = getFindRequestQuery(query)

  const safeFindInPage = useCallback(
    (text: string, opts?: Electron.FindInPageOptions): void => {
      if (!text) {
        return
      }
      void surface.runFind(text, opts)
    },
    [surface]
  )

  const safeStopFindInPage = useCallback((): void => {
    void surface.stopFind('clearSelection')
  }, [surface])

  // Why: Electron's findNext means "start a NEW session" — follow-up requests that
  // advance the selection must pass false, or every Enter restarts at the first match.
  const findNext = useCallback(() => {
    if (requestQuery) {
      const findNext = activeFindQueryRef.current !== requestQuery
      safeFindInPage(requestQuery, { forward: true, findNext })
      activeFindQueryRef.current = requestQuery
    }
  }, [requestQuery, safeFindInPage])

  const findPrevious = useCallback(() => {
    if (requestQuery) {
      const findNext = activeFindQueryRef.current !== requestQuery
      safeFindInPage(requestQuery, { forward: false, findNext })
      activeFindQueryRef.current = requestQuery
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
      activeFindQueryRef.current = null
      return
    }
    if (!requestQuery) {
      activeFindQueryRef.current = null
      safeStopFindInPage()
      return
    }

    // A reopen or a changed query starts a fresh session, so findNext must be true here.
    const runFind = (): void => {
      if (activeFindQueryRef.current === requestQuery) {
        return
      }
      safeFindInPage(requestQuery, { findNext: true })
      activeFindQueryRef.current = requestQuery
    }
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

  // A surface can replace its underlying guest while the find bar stays open.
  useEffect(() => {
    if (!isOpen) {
      return
    }
    surface.refresh()
    return surface.subscribeFindResults(({ activeMatchOrdinal, matches }) => {
      setActiveMatch(activeMatchOrdinal)
      setTotalMatches(matches)
    })
  }, [surface, isOpen, guestGeneration])

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
      ref={occlusionRef}
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
