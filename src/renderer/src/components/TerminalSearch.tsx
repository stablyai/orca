import { useEffect, useRef, useState, useCallback } from 'react'
import { ChevronUp, ChevronDown, X, CaseSensitive, Regex } from 'lucide-react'
import type { SearchAddon } from '@xterm/addon-search'

interface TerminalSearchProps {
  isOpen: boolean
  onClose: () => void
  searchAddon: SearchAddon | null
}

export default function TerminalSearch({
  isOpen,
  onClose,
  searchAddon
}: TerminalSearchProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)

  const searchOptions = useCallback(
    (incremental = false) => ({ caseSensitive, regex, incremental }),
    [caseSensitive, regex]
  )

  const findNext = useCallback(() => {
    if (searchAddon && query) {
      searchAddon.findNext(query, searchOptions())
    }
  }, [searchAddon, query, searchOptions])

  const findPrevious = useCallback(() => {
    if (searchAddon && query) {
      searchAddon.findPrevious(query, searchOptions())
    }
  }, [searchAddon, query, searchOptions])

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus()
    } else {
      searchAddon?.clearDecorations()
    }
  }, [isOpen, searchAddon])

  useEffect(() => {
    if (!query) {
      searchAddon?.clearDecorations()
      return
    }
    if (searchAddon && isOpen) {
      searchAddon.findNext(query, { caseSensitive, regex, incremental: true })
    }
  }, [query, searchAddon, isOpen, caseSensitive, regex])

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

  if (!isOpen) return null

  return (
    <div
      data-terminal-search-root
      className="absolute top-2 right-2 z-50 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/95 px-2 py-1 shadow-lg backdrop-blur-sm"
      style={{ width: 300 }}
      onKeyDown={handleKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search..."
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-zinc-500"
      />

      <button
        onClick={() => setCaseSensitive((v) => !v)}
        className={`flex size-6 shrink-0 items-center justify-center rounded ${
          caseSensitive ? 'bg-zinc-700/50 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        title="Case sensitive"
      >
        <CaseSensitive size={14} />
      </button>

      <button
        onClick={() => setRegex((v) => !v)}
        className={`flex size-6 shrink-0 items-center justify-center rounded ${
          regex ? 'bg-zinc-700/50 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        title="Regex"
      >
        <Regex size={14} />
      </button>

      <div className="mx-0.5 h-4 w-px bg-zinc-700" />

      <button
        onClick={findPrevious}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title="Previous match"
      >
        <ChevronUp size={14} />
      </button>

      <button
        onClick={findNext}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title="Next match"
      >
        <ChevronDown size={14} />
      </button>

      <div className="mx-0.5 h-4 w-px bg-zinc-700" />

      <button
        onClick={onClose}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title="Close"
      >
        <X size={14} />
      </button>
    </div>
  )
}
