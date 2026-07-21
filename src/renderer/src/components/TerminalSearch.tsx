import { useEffect, useState, useCallback } from 'react'
import { ChevronUp, ChevronDown, X, CaseSensitive, Regex } from 'lucide-react'
import type { SearchAddon } from '@xterm/addon-search'
import { Button } from '@/components/ui/button'
import type { SearchState } from '@/components/terminal-pane/keyboard-handlers'
import { translate } from '@/i18n/i18n'
import { getFindRequestQuery } from '@/lib/find-query-bounds'
import { safeFind } from './terminal-search-safe-find'
import { formatKeybinding } from '../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type TerminalSearchProps = {
  isOpen: boolean
  onClose: () => void
  searchAddon: SearchAddon | null
  searchStateRef: React.RefObject<SearchState>
}

export default function TerminalSearch({
  isOpen,
  onClose,
  searchAddon,
  searchStateRef
}: TerminalSearchProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const requestQuery = getFindRequestQuery(query)
  const platform = getShortcutPlatform()
  const enterKeys = ['Enter']
  const shiftEnterKeys = ['Shift', 'Enter']
  const modGKeys = formatKeybinding('Mod+G', platform)
  const modShiftGKeys = formatKeybinding('Mod+Shift+G', platform)

  // Why: the default xterm SearchAddon highlights blend into common
  // terminal backgrounds (see orca#612). Providing explicit decoration
  // colors gives all matches a visible yellow background and the
  // current match a brighter orange, matching the contrast VS Code and
  // iTerm2 use for terminal search. xterm requires #RRGGBB format for
  // the background colors.
  const searchOptions = useCallback(
    (incremental: boolean = false) => ({
      caseSensitive,
      regex,
      incremental,
      decorations: {
        matchBackground: '#5c4a00',
        matchBorder: '#5c4a00',
        matchOverviewRuler: '#ffcc00',
        activeMatchBackground: '#c4580e',
        activeMatchBorder: '#ffcf6b',
        activeMatchColorOverviewRuler: '#ff9900'
      }
    }),
    [caseSensitive, regex]
  )

  const findNext = useCallback(() => {
    if (searchAddon && requestQuery) {
      safeFind(
        (term, options) => searchAddon.findNext(term, options),
        requestQuery,
        searchOptions()
      )
    }
  }, [searchAddon, requestQuery, searchOptions])

  const findPrevious = useCallback(() => {
    if (searchAddon && requestQuery) {
      safeFind(
        (term, options) => searchAddon.findPrevious(term, options),
        requestQuery,
        searchOptions()
      )
    }
  }, [searchAddon, requestQuery, searchOptions])

  const handleInputRef = useCallback((input: HTMLInputElement | null): void => {
    input?.focus()
  }, [])

  useEffect(() => {
    // Keep the ref in sync so the keyboard handler (Cmd+G / Cmd+Shift+G)
    // can read the current search state without lifting it to parent state.
    searchStateRef.current = { query: requestQuery ?? '', caseSensitive, regex }

    if (!isOpen) {
      searchAddon?.clearDecorations()
      return
    }
    if (!requestQuery) {
      searchAddon?.clearDecorations()
      return
    }
    if (searchAddon) {
      safeFind(
        (term, options) => searchAddon.findNext(term, options),
        requestQuery,
        searchOptions(true)
      )
    }
  }, [requestQuery, searchAddon, isOpen, caseSensitive, regex, searchStateRef, searchOptions])

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
    <TooltipProvider delayDuration={300}>
      <div
        data-terminal-search-root
        className="absolute top-2 right-2 z-50 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/95 px-2 py-1 shadow-lg backdrop-blur-sm"
        style={{ width: 300 }}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={handleInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={translate('auto.components.TerminalSearch.e07012f26e', 'Search...')}
          className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-zinc-500"
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setCaseSensitive((v) => !v)}
              className={`flex size-6 shrink-0 items-center justify-center rounded ${
                caseSensitive ? 'bg-zinc-700/50 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'
              }`}
              aria-label={translate('auto.components.TerminalSearch.90c61387d9', 'Case sensitive')}
            >
              <CaseSensitive size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate('auto.components.TerminalSearch.90c61387d9', 'Case sensitive')}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setRegex((v) => !v)}
              className={`flex size-6 shrink-0 items-center justify-center rounded ${
                regex ? 'bg-zinc-700/50 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'
              }`}
              aria-label={translate('auto.components.TerminalSearch.42e466b9f1', 'Regex')}
            >
              <Regex size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate('auto.components.TerminalSearch.42e466b9f1', 'Regex')}
          </TooltipContent>
        </Tooltip>

        <div className="mx-0.5 h-4 w-px bg-zinc-700" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={findPrevious}
              className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
              aria-label={translate('auto.components.TerminalSearch.0f3066256e', 'Previous match')}
            >
              <ChevronUp size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4} className="flex items-center gap-2">
            <span>{translate('auto.components.TerminalSearch.0f3066256e', 'Previous match')}</span>
            <div className="flex items-center gap-1.5">
              <ShortcutKeyCombo keys={shiftEnterKeys} />
              <span className="text-[10px] text-muted-foreground">
                {translate('auto.components.TerminalSearch.or', 'or')}
              </span>
              <ShortcutKeyCombo keys={modShiftGKeys} />
            </div>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={findNext}
              className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
              aria-label={translate('auto.components.TerminalSearch.7cb40c04eb', 'Next match')}
            >
              <ChevronDown size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4} className="flex items-center gap-2">
            <span>{translate('auto.components.TerminalSearch.7cb40c04eb', 'Next match')}</span>
            <div className="flex items-center gap-1.5">
              <ShortcutKeyCombo keys={enterKeys} />
              <span className="text-[10px] text-muted-foreground">
                {translate('auto.components.TerminalSearch.or', 'or')}
              </span>
              <ShortcutKeyCombo keys={modGKeys} />
            </div>
          </TooltipContent>
        </Tooltip>

        <div className="mx-0.5 h-4 w-px bg-zinc-700" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
              aria-label={translate('auto.components.TerminalSearch.db234b7519', 'Close')}
            >
              <X size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate('auto.components.TerminalSearch.db234b7519', 'Close')}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
