import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewViewport } from './use-markdown-preview-viewport'

export function MarkdownPreviewSearchBar({
  foundation,
  viewport
}: {
  foundation: MarkdownPreviewFoundation
  viewport: MarkdownPreviewViewport
}): React.JSX.Element {
  const { rootRef, setSearchInputElement, query, setQuery, matchCount, activeMatchIndex } =
    foundation
  const { moveToMatch, closeSearch } = viewport

  return (
    <div className="markdown-preview-search" onKeyDown={(event) => event.stopPropagation()}>
      <div className="markdown-preview-search-field">
        <Input
          ref={setSearchInputElement}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.shiftKey) {
              event.preventDefault()
              moveToMatch(-1)
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              moveToMatch(1)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              closeSearch()
              rootRef.current?.focus()
            }
          }}
          placeholder={translate(
            'auto.components.editor.MarkdownPreview.517aea303b',
            'Find in preview'
          )}
          className="markdown-preview-search-input h-7 !border-0 bg-transparent px-2 shadow-none focus-visible:!border-0 focus-visible:ring-0"
          aria-label={translate(
            'auto.components.editor.MarkdownPreview.ec77985138',
            'Find in markdown preview'
          )}
        />
      </div>
      <div className="markdown-preview-search-status">
        {query && matchCount === 0
          ? translate('auto.components.editor.MarkdownPreview.c5dc92cfe3', 'No results')
          : `${matchCount === 0 ? 0 : activeMatchIndex + 1}/${matchCount}`}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => moveToMatch(-1)}
        disabled={matchCount === 0}
        title={translate('auto.components.editor.MarkdownPreview.1febd97f5c', 'Previous match')}
        aria-label={translate(
          'auto.components.editor.MarkdownPreview.1febd97f5c',
          'Previous match'
        )}
        className="markdown-preview-search-button"
      >
        <ChevronUp size={14} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => moveToMatch(1)}
        disabled={matchCount === 0}
        title={translate('auto.components.editor.MarkdownPreview.b42c41bd0d', 'Next match')}
        aria-label={translate('auto.components.editor.MarkdownPreview.b42c41bd0d', 'Next match')}
        className="markdown-preview-search-button"
      >
        <ChevronDown size={14} />
      </Button>
      <div className="markdown-preview-search-divider" />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={closeSearch}
        title={translate('auto.components.editor.MarkdownPreview.12052c639c', 'Close search')}
        aria-label={translate('auto.components.editor.MarkdownPreview.12052c639c', 'Close search')}
        className="markdown-preview-search-button"
      >
        <X size={14} />
      </Button>
    </div>
  )
}
