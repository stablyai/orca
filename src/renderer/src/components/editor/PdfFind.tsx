import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'

type PdfFindProps = {
  isOpen: boolean
  onClose: () => void
  eventBusRef: React.RefObject<InstanceType<typeof EventBus> | null>
}

export default function PdfFind({
  isOpen,
  onClose,
  eventBusRef
}: PdfFindProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [totalMatches, setTotalMatches] = useState(0)

  const dispatchFind = useCallback(
    (type: string, findPrevious = false): void => {
      const eventBus = eventBusRef.current
      if (!eventBus) {
        return
      }
      eventBus.dispatch('find', {
        source: null,
        type,
        query,
        highlightAll: true,
        caseSensitive: false,
        entireWord: false,
        findPrevious
      })
    },
    [eventBusRef, query]
  )

  const findNext = useCallback(() => {
    if (query) {
      dispatchFind('again', false)
    }
  }, [query, dispatchFind])

  const findPrevious = useCallback(() => {
    if (query) {
      dispatchFind('again', true)
    }
  }, [query, dispatchFind])

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      const eventBus = eventBusRef.current
      if (eventBus) {
        eventBus.dispatch('findbarclose', { source: null })
      }
      setActiveMatch(0)
      setTotalMatches(0)
    }
  }, [isOpen, eventBusRef])

  useEffect(() => {
    if (!query) {
      const eventBus = eventBusRef.current
      if (eventBus) {
        eventBus.dispatch('findbarclose', { source: null })
      }
      setActiveMatch(0)
      setTotalMatches(0)
      return
    }
    if (isOpen) {
      dispatchFind('')
    }
  }, [query, isOpen, dispatchFind, eventBusRef])

  useEffect(() => {
    const eventBus = eventBusRef.current
    if (!eventBus || !isOpen) {
      return
    }
    const handleMatchesCount = (evt: {
      matchesCount: { current: number; total: number }
    }): void => {
      setActiveMatch(evt.matchesCount.current)
      setTotalMatches(evt.matchesCount.total)
    }
    eventBus.on('updatefindmatchescount', handleMatchesCount)
    return () => {
      eventBus.off('updatefindmatchescount', handleMatchesCount)
    }
  }, [eventBusRef, isOpen])

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
        placeholder="Find in page..."
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-zinc-500"
      />
      {query ? (
        <span className="shrink-0 text-xs text-zinc-400">
          {totalMatches > 0 ? `${activeMatch} of ${totalMatches}` : 'No matches'}
        </span>
      ) : null}
      <div className="mx-0.5 h-4 w-px bg-zinc-700" />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={findPrevious}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title="Previous match"
      >
        <ChevronUp size={14} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={findNext}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title="Next match"
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
        title="Close"
      >
        <X size={14} />
      </Button>
    </div>
  )
}
