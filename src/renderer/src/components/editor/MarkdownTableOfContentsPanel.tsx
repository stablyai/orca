import React from 'react'
import { ListTree, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MarkdownTocItem } from './markdown-table-of-contents'

type MarkdownTableOfContentsPanelProps = {
  items: MarkdownTocItem[]
  onClose: () => void
  onNavigate: (id: string) => void
}

function MarkdownTocRow({
  depth,
  item,
  onNavigate
}: {
  depth: number
  item: MarkdownTocItem
  onNavigate: (id: string) => void
}): React.JSX.Element {
  return (
    <>
      <button
        type="button"
        className="markdown-toc-row"
        style={{ paddingLeft: 12 + depth * 14 }}
        title={item.title}
        onClick={() => onNavigate(item.id)}
      >
        <span className="markdown-toc-level">H{item.level}</span>
        <span className="markdown-toc-title">{item.title}</span>
      </button>
      {item.children.map((child) => (
        <MarkdownTocRow key={child.id} depth={depth + 1} item={child} onNavigate={onNavigate} />
      ))}
    </>
  )
}

export function MarkdownTableOfContentsPanel({
  items,
  onClose,
  onNavigate
}: MarkdownTableOfContentsPanelProps): React.JSX.Element {
  return (
    <aside className="markdown-toc-panel" aria-label="Table of contents">
      <div className="markdown-toc-header">
        <ListTree className="size-3.5 text-muted-foreground" />
        <span>Table of Contents</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label="Close table of contents"
          title="Close table of contents"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="markdown-toc-list">
        {items.length > 0 ? (
          items.map((item) => (
            <MarkdownTocRow key={item.id} depth={0} item={item} onNavigate={onNavigate} />
          ))
        ) : (
          <div className="markdown-toc-empty">No headings</div>
        )}
      </div>
    </aside>
  )
}
