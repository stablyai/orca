import React from 'react'
import type { Editor } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { commitRow } from './rich-markdown-commands'
import type { DocLinkMenuRow, DocLinkMenuState } from './rich-markdown-commands'

type RichMarkdownDocLinkMenuProps = {
  editor: Editor | null
  menu: DocLinkMenuState
  rows: DocLinkMenuRow[]
  totalMatches: number
  selectedIndex: number
}

export function RichMarkdownDocLinkMenu({
  editor,
  menu,
  rows,
  totalMatches,
  selectedIndex
}: RichMarkdownDocLinkMenuProps): React.JSX.Element {
  const overflow = totalMatches > rows.length
  return (
    <div
      className="rich-markdown-doc-link-menu"
      style={{ left: menu.left, top: menu.top }}
      role="listbox"
      aria-label="Markdown document links"
    >
      {rows.length === 0 ? (
        <div className="rich-markdown-doc-link-item is-empty">No documents found</div>
      ) : (
        rows.map((row, index) => {
          const rowKey = row.kind === 'document' ? row.document.filePath : row.id
          return (
            <button
              key={rowKey}
              type="button"
              className={cn('rich-markdown-doc-link-item', index === selectedIndex && 'is-active')}
              // Why: mousedown inside the editor-mounted popover would otherwise
              // blur the editor before click fires, losing the selection we need
              // to run the commit transaction against.
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
          Showing {rows.length} of {totalMatches}
        </div>
      ) : null}
      <div className="rich-markdown-doc-link-hint">
        ↑↓ navigate&nbsp;&nbsp;↵ select&nbsp;&nbsp;esc dismiss
      </div>
    </div>
  )
}
