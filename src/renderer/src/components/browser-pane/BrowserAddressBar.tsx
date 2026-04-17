import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { useAppStore } from '@/store'

const MAX_SUGGESTIONS = 8

type BrowserAddressBarProps = {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onNavigate: (url: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}

function scoreSuggestion(
  entry: { url: string; title: string; lastVisitedAt: number; visitCount: number },
  query: string
): number {
  const lowerQuery = query.toLowerCase()
  const lowerUrl = entry.url.toLowerCase()
  const lowerTitle = entry.title.toLowerCase()

  if (!lowerUrl.includes(lowerQuery) && !lowerTitle.includes(lowerQuery)) {
    return -1
  }

  let score = 0
  if (lowerUrl.startsWith(lowerQuery) || lowerUrl.startsWith(`https://${lowerQuery}`)) {
    score += 100
  }
  score += Math.min(entry.visitCount, 50)
  const ageHours = (Date.now() - entry.lastVisitedAt) / (1000 * 60 * 60)
  score += Math.max(0, 24 - ageHours)
  return score
}

export default function BrowserAddressBar({
  value,
  onChange,
  onSubmit,
  onNavigate,
  inputRef
}: BrowserAddressBarProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [selectedValue, setSelectedValue] = useState('')
  const browserUrlHistory = useAppStore((s) => s.browserUrlHistory)
  const closingRef = useRef(false)
  const openedAtRef = useRef(0)

  const suggestions = useMemo(() => {
    if (browserUrlHistory.length === 0) {
      return []
    }
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('data:')) {
      return [...browserUrlHistory]
        .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
        .slice(0, MAX_SUGGESTIONS)
    }

    const scored = browserUrlHistory
      .map((entry) => ({ entry, score: scoreSuggestion(entry, trimmed) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS)

    return scored.map((item) => item.entry)
  }, [browserUrlHistory, value])

  const handleFocus = useCallback(() => {
    if (closingRef.current) {
      return
    }
    inputRef.current?.select()
    if (browserUrlHistory.length > 0) {
      openedAtRef.current = Date.now()
      setOpen(true)
    }
  }, [browserUrlHistory.length, inputRef])

  const handleBlur = useCallback(() => {
    // Why: delay close so that clicking a suggestion item registers before
    // the popover unmounts. Without this, onSelect never fires because the
    // mousedown on PopoverContent triggers input blur first.
    //
    // Why (grace window): BrowserPane's focusAddressBarNow() retries focus
    // across multiple animation frames to fight webview focus stealing. Each
    // cycle can cause a transient blur on the input. Without this guard the
    // popover opens on focus, immediately gets a blur, and closes ~150ms later
    // — producing the "flash then disappear" on first click.
    const elapsed = Date.now() - openedAtRef.current
    const grace = elapsed < 400
    setTimeout(() => {
      if (grace && inputRef.current && document.activeElement === inputRef.current) {
        return
      }
      setOpen(false)
    }, 200)
  }, [inputRef])

  const handleSelect = useCallback(
    (url: string) => {
      closingRef.current = true
      setOpen(false)
      onNavigate(url)
      setTimeout(() => {
        closingRef.current = false
      }, 100)
    },
    [onNavigate]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setSelectedValue('')
        return
      }

      if (!open || suggestions.length === 0) {
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedValue((prev) => {
          const idx = suggestions.findIndex((s) => s.url === prev)
          const next = idx < suggestions.length - 1 ? idx + 1 : 0
          return suggestions[next].url
        })
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedValue((prev) => {
          const idx = suggestions.findIndex((s) => s.url === prev)
          const next = idx > 0 ? idx - 1 : suggestions.length - 1
          return suggestions[next].url
        })
        return
      }

      if (event.key === 'Enter' && selectedValue) {
        const match = suggestions.find((s) => s.url === selectedValue)
        if (match) {
          event.preventDefault()
          handleSelect(match.url)
        }
      }
    },
    [open, suggestions, selectedValue, handleSelect]
  )

  useEffect(() => {
    if (open && suggestions.length === 0) {
      setOpen(false)
    }
  }, [open, suggestions.length])

  useEffect(() => {
    setSelectedValue('')
  }, [suggestions])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Why: Radix fires onOpenChange(false) when it detects an outside
        // interaction, but during the focus-retry loop the input may still
        // hold focus. Only allow programmatic closes (setOpen(false) from
        // our handlers) or genuine outside dismissals.
        if (!next && inputRef.current && document.activeElement === inputRef.current) {
          return
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <form
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3 py-1 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault()
            setOpen(false)
            onSubmit()
          }}
        >
          <Globe className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            data-orca-browser-address-bar="true"
            className="h-auto border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="browser-history-listbox"
            aria-autocomplete="list"
          />
        </form>
      </PopoverTrigger>
      {suggestions.length > 0 && (
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] p-0"
          onOpenAutoFocus={(e) => {
            // Why: prevent the popover from stealing focus away from the
            // address bar input. The user is still typing; the popover is
            // an overlay of suggestions, not a focus target.
            e.preventDefault()
          }}
        >
          <Command shouldFilter={false} value={selectedValue} onValueChange={setSelectedValue}>
            <CommandList id="browser-history-listbox" role="listbox">
              <CommandGroup>
                {suggestions.map((entry) => (
                  <CommandItem
                    key={entry.url}
                    value={entry.url}
                    onSelect={() => handleSelect(entry.url)}
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{entry.title}</span>
                      <span className="truncate text-xs text-muted-foreground">{entry.url}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      )}
    </Popover>
  )
}
