import React from 'react'
import type { Editor } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { commitRow } from './rich-markdown-commands'
import type { DocLinkMenuRow, DocLinkMenuState } from './rich-markdown-commands'
import { translate } from '@/i18n/i18n'
import { RichMarkdownCompletionPopover } from './RichMarkdownCompletionPopover'
import { useRichMarkdownCompletionScroll } from './useRichMarkdownCompletionScroll'

type RichMarkdownDocLinkMenuProps = {
  editor: Editor | null
  menu: DocLinkMenuState
  rows: DocLinkMenuRow[]
  totalMatches: number
  selectedIndex: number
  onClose: () => void
}

export function RichMarkdownDocLinkMenu({
  editor,
  menu,
  rows,
  totalMatches,
  selectedIndex,
  onClose
}: RichMarkdownDocLinkMenuProps): React.JSX.Element {
  const { viewportRef, activeItemRef } = useRichMarkdownCompletionScroll(selectedIndex, rows)
  const overflow = totalMatches > rows.length
  return (
    <RichMarkdownCompletionPopover
      editor={editor}
      position={menu.to}
      onClose={onClose}
      viewportRef={viewportRef}
      className="rich-markdown-doc-link-menu scrollbar-sleek"
      role="listbox"
      ariaLabel={translate(
        'auto.components.editor.RichMarkdownDocLinkMenu.0e8489bc11',
        'Markdown document links'
      )}
    >
      {rows.length === 0 ? (
        <div className="rich-markdown-doc-link-item is-empty">
          {translate(
            'auto.components.editor.RichMarkdownDocLinkMenu.63ced7cb9b',
            'No documents found'
          )}
        </div>
      ) : (
        rows.map((row, index) => {
          const rowKey = row.kind === 'document' ? row.document.filePath : row.id
          return (
            <button
              key={rowKey}
              ref={index === selectedIndex ? activeItemRef : undefined}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={cn('rich-markdown-doc-link-item', index === selectedIndex && 'is-active')}
              // Prevent blur before click so the commit transaction retains its editor selection.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => editor && commitRow(editor, menu, row)}
            >
              {row.kind === 'document' ? (
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span className="truncate text-sm font-medium">{row.document.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {row.document.relativePath}
                  </span>
                </span>
              ) : (
                <span className="truncate text-sm">{row.label}</span>
              )}
            </button>
          )
        })
      )}
      {overflow ? (
        <div className="rich-markdown-doc-link-footer">
          {translate(
            'auto.components.editor.RichMarkdownDocLinkMenu.showingOfTotal',
            'Showing {{shown}} of {{total}}',
            { shown: rows.length, total: totalMatches }
          )}
        </div>
      ) : null}
      <div className="rich-markdown-doc-link-hint">
        {translate(
          'auto.components.editor.RichMarkdownDocLinkMenu.e17b987473',
          '↑↓ navigate&nbsp;&nbsp;↵ select&nbsp;&nbsp;esc dismiss'
        )}
      </div>
    </RichMarkdownCompletionPopover>
  )
}
