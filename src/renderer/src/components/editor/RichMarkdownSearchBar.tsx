import React from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

type RichMarkdownSearchBarProps = {
  activeMatchIndex: number
  isOpen: boolean
  matchCount: number
  onClose: () => void
  onMoveToMatch: (direction: 1 | -1) => void
  onQueryChange: (query: string) => void
  query: string
  searchInputRef: React.RefObject<HTMLInputElement | null>
}

export function RichMarkdownSearchBar({
  activeMatchIndex,
  isOpen,
  matchCount,
  onClose,
  onMoveToMatch,
  onQueryChange,
  query,
  searchInputRef
}: RichMarkdownSearchBarProps): React.JSX.Element | null {
  if (!isOpen) {
    return null
  }

  const keepSearchFocus = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // Why: rich-mode find drives navigation through the ProseMirror selection.
    // Letting the toolbar buttons take focus interrupts that selection flow and
    // makes mouse-based next/previous navigation appear broken.
    event.preventDefault()
  }

  return (
    <div className="rich-markdown-search" onKeyDown={(event) => event.stopPropagation()}>
      <div className="rich-markdown-search-field">
        <Input
          ref={searchInputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.shiftKey) {
              event.preventDefault()
              onMoveToMatch(-1)
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              onMoveToMatch(1)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
          placeholder={translate("auto.components.editor.RichMarkdownSearchBar.98b89276f3", "Find in rich editor")}
          className="rich-markdown-search-input h-7 !border-0 bg-transparent px-2 shadow-none focus-visible:!border-0 focus-visible:ring-0"
          aria-label={translate("auto.components.editor.RichMarkdownSearchBar.158c645829", "Find in rich markdown editor")}
        />
      </div>
      <div className="rich-markdown-search-status">
        {query && matchCount === 0
          ? translate("auto.components.editor.RichMarkdownSearchBar.a86958d508", "No results")
          : `${matchCount === 0 ? 0 : activeMatchIndex + 1}/${matchCount}`}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onMouseDown={keepSearchFocus}
        onClick={() => onMoveToMatch(-1)}
        disabled={matchCount === 0}
        title={translate("auto.components.editor.RichMarkdownSearchBar.32ae8d7d57", "Previous match")}
        aria-label={translate("auto.components.editor.RichMarkdownSearchBar.32ae8d7d57", "Previous match")}
        className="rich-markdown-search-button"
      >
        <ChevronUp size={14} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onMouseDown={keepSearchFocus}
        onClick={() => onMoveToMatch(1)}
        disabled={matchCount === 0}
        title={translate("auto.components.editor.RichMarkdownSearchBar.f7bcecbe26", "Next match")}
        aria-label={translate("auto.components.editor.RichMarkdownSearchBar.f7bcecbe26", "Next match")}
        className="rich-markdown-search-button"
      >
        <ChevronDown size={14} />
      </Button>
      <div className="rich-markdown-search-divider" />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onMouseDown={keepSearchFocus}
        onClick={onClose}
        title={translate("auto.components.editor.RichMarkdownSearchBar.de68b75bde", "Close search")}
        aria-label={translate("auto.components.editor.RichMarkdownSearchBar.de68b75bde", "Close search")}
        className="rich-markdown-search-button"
      >
        <X size={14} />
      </Button>
    </div>
  )
}
