import React from 'react'
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Replace,
  ReplaceAll,
  WholeWord,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'

type RichMarkdownSearchBarProps = {
  activeMatchIndex: number
  isOpen: boolean
  isReplaceMode: boolean
  matchCase: boolean
  matchCount: number
  query: string
  replaceQuery: string
  replaceDisabled: boolean
  searchInputRef: React.RefObject<HTMLInputElement | null>
  wholeWord: boolean
  onClose: () => void
  onMoveToMatch: (direction: 1 | -1) => void
  onQueryChange: (query: string) => void
  onReplaceAll: () => void
  onReplaceCurrent: () => void
  onReplaceQueryChange: (query: string) => void
  onToggleMatchCase: () => void
  onToggleReplaceMode: () => void
  onToggleWholeWord: () => void
}

export function RichMarkdownSearchBar({
  activeMatchIndex,
  isOpen,
  isReplaceMode,
  matchCase,
  matchCount,
  query,
  replaceQuery,
  replaceDisabled,
  searchInputRef,
  wholeWord,
  onClose,
  onMoveToMatch,
  onQueryChange,
  onReplaceAll,
  onReplaceCurrent,
  onReplaceQueryChange,
  onToggleMatchCase,
  onToggleReplaceMode,
  onToggleWholeWord
}: RichMarkdownSearchBarProps): React.JSX.Element | null {
  // Why: surface the same replace shortcut the source editor uses so the toggle
  // is discoverable; reads the user's effective binding, formatted per platform.
  const replaceShortcut = useOptionalShortcutLabel('editor.replace')
  const readOnlyExplanationId = React.useId()

  if (!isOpen) {
    return null
  }

  const keepSearchFocus = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // Why: rich-mode find drives navigation through the ProseMirror selection.
    // Letting the toolbar buttons take focus interrupts that selection flow and
    // makes mouse-based next/previous navigation appear broken.
    event.preventDefault()
  }

  const noMatches = matchCount === 0
  const readOnlyReplaceExplanation = translate(
    'auto.components.editor.RichMarkdownSearchBar.preservedRichContentReadOnly',
    'Preserved rich content is read-only in rich mode.'
  )
  const toggleReplaceLabel = isReplaceMode
    ? translate('auto.components.editor.RichMarkdownSearchBar.e8c147435f', 'Hide replace')
    : translate('auto.components.editor.RichMarkdownSearchBar.9cdc38be33', 'Toggle replace')
  const toggleReplaceTitle = replaceShortcut
    ? `${toggleReplaceLabel} (${replaceShortcut})`
    : toggleReplaceLabel

  return (
    <div className="rich-markdown-search" onKeyDown={(event) => event.stopPropagation()}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onMouseDown={keepSearchFocus}
        onClick={onToggleReplaceMode}
        title={toggleReplaceTitle}
        aria-label={translate(
          'auto.components.editor.RichMarkdownSearchBar.9cdc38be33',
          'Toggle replace'
        )}
        aria-expanded={isReplaceMode}
        className="rich-markdown-search-toggle"
      >
        {isReplaceMode ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </Button>
      <div className="rich-markdown-search-rows">
        <div className="rich-markdown-search-row">
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
              placeholder={translate(
                'auto.components.editor.RichMarkdownSearchBar.98b89276f3',
                'Find in rich editor'
              )}
              className="rich-markdown-search-input h-7 !border-0 bg-transparent px-2 shadow-none focus-visible:!border-0 focus-visible:ring-0"
              aria-label={translate(
                'auto.components.editor.RichMarkdownSearchBar.158c645829',
                'Find in rich markdown editor'
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onMouseDown={keepSearchFocus}
              onClick={onToggleMatchCase}
              data-active={matchCase ? 'true' : undefined}
              aria-pressed={matchCase}
              title={translate(
                'auto.components.editor.RichMarkdownSearchBar.482b637099',
                'Match case'
              )}
              aria-label={translate(
                'auto.components.editor.RichMarkdownSearchBar.482b637099',
                'Match case'
              )}
              className="rich-markdown-search-option"
            >
              <CaseSensitive size={14} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onMouseDown={keepSearchFocus}
              onClick={onToggleWholeWord}
              data-active={wholeWord ? 'true' : undefined}
              aria-pressed={wholeWord}
              title={translate(
                'auto.components.editor.RichMarkdownSearchBar.68d090241d',
                'Match whole word'
              )}
              aria-label={translate(
                'auto.components.editor.RichMarkdownSearchBar.68d090241d',
                'Match whole word'
              )}
              className="rich-markdown-search-option"
            >
              <WholeWord size={14} />
            </Button>
          </div>
          <div className="rich-markdown-search-status">
            {query && noMatches
              ? translate('auto.components.editor.RichMarkdownSearchBar.a86958d508', 'No results')
              : `${noMatches ? 0 : activeMatchIndex + 1}/${matchCount}`}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onMouseDown={keepSearchFocus}
            onClick={() => onMoveToMatch(-1)}
            disabled={noMatches}
            title={translate(
              'auto.components.editor.RichMarkdownSearchBar.32ae8d7d57',
              'Previous match'
            )}
            aria-label={translate(
              'auto.components.editor.RichMarkdownSearchBar.32ae8d7d57',
              'Previous match'
            )}
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
            disabled={noMatches}
            title={translate(
              'auto.components.editor.RichMarkdownSearchBar.f7bcecbe26',
              'Next match'
            )}
            aria-label={translate(
              'auto.components.editor.RichMarkdownSearchBar.f7bcecbe26',
              'Next match'
            )}
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
            title={translate(
              'auto.components.editor.RichMarkdownSearchBar.de68b75bde',
              'Close search'
            )}
            aria-label={translate(
              'auto.components.editor.RichMarkdownSearchBar.de68b75bde',
              'Close search'
            )}
            className="rich-markdown-search-button"
          >
            <X size={14} />
          </Button>
        </div>
        {isReplaceMode ? (
          <div className="rich-markdown-search-row">
            <div className="rich-markdown-search-field">
              <Input
                value={replaceQuery}
                onChange={(event) => onReplaceQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onReplaceCurrent()
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    onClose()
                  }
                }}
                placeholder={translate(
                  'auto.components.editor.RichMarkdownSearchBar.fd97c7e585',
                  'Replace'
                )}
                className="rich-markdown-search-input h-7 !border-0 bg-transparent px-2 shadow-none focus-visible:!border-0 focus-visible:ring-0"
                aria-label={translate(
                  'auto.components.editor.RichMarkdownSearchBar.44682b4159',
                  'Replace in rich markdown editor'
                )}
                aria-describedby={replaceDisabled ? readOnlyExplanationId : undefined}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onMouseDown={keepSearchFocus}
              onClick={onReplaceCurrent}
              disabled={noMatches || replaceDisabled}
              title={
                replaceDisabled
                  ? readOnlyReplaceExplanation
                  : translate('auto.components.editor.RichMarkdownSearchBar.fd97c7e585', 'Replace')
              }
              aria-label={translate(
                'auto.components.editor.RichMarkdownSearchBar.fd97c7e585',
                'Replace'
              )}
              className="rich-markdown-search-button"
            >
              <Replace size={14} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onMouseDown={keepSearchFocus}
              onClick={onReplaceAll}
              disabled={noMatches || replaceDisabled}
              title={
                replaceDisabled
                  ? readOnlyReplaceExplanation
                  : translate(
                      'auto.components.editor.RichMarkdownSearchBar.c2884f5e95',
                      'Replace all'
                    )
              }
              aria-label={translate(
                'auto.components.editor.RichMarkdownSearchBar.c2884f5e95',
                'Replace all'
              )}
              className="rich-markdown-search-button"
            >
              <ReplaceAll size={14} />
            </Button>
            {replaceDisabled ? (
              <span id={readOnlyExplanationId} className="sr-only" role="status">
                {readOnlyReplaceExplanation}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
