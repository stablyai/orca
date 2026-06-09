import React, { useEffect, useState } from 'react'
import { ChevronRight, ListTree, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { MarkdownTocItem, MarkdownTocLevel } from './markdown-table-of-contents'
import {
  collapseMarkdownTocToLevel,
  isMarkdownTocItemExpanded,
  pruneMarkdownTocCollapsedIds,
  toggleMarkdownTocCollapsedId
} from './markdown-toc-collapse-state'

type MarkdownTableOfContentsPanelProps = {
  items: MarkdownTocItem[]
  onClose: () => void
  onNavigate: (id: string) => void
}

const TOC_LEVELS: MarkdownTocLevel[] = [1, 2, 3]
const TOC_INDENT_BASE_PX = 12
const TOC_INDENT_STEP_PX = 12

function MarkdownTocRow({
  collapsedIds,
  depth,
  item,
  onNavigate,
  onToggleCollapsed
}: {
  collapsedIds: ReadonlySet<string>
  depth: number
  item: MarkdownTocItem
  onNavigate: (id: string) => void
  onToggleCollapsed: (id: string) => void
}): React.JSX.Element {
  const hasChildren = item.children.length > 0
  const expanded = isMarkdownTocItemExpanded(collapsedIds, item)
  // Why: parents already shift title right via the disclosure chevron, so deeper
  // parents skip the base inset; only the root row keeps it so top-level titles
  // are not flush against the panel edge.
  const rowPaddingLeft = hasChildren
    ? depth === 0
      ? TOC_INDENT_BASE_PX
      : depth * TOC_INDENT_STEP_PX
    : TOC_INDENT_BASE_PX + depth * TOC_INDENT_STEP_PX

  return (
    <>
      <div className="markdown-toc-row" style={{ paddingLeft: rowPaddingLeft }}>
        {hasChildren ? (
          <button
            type="button"
            className="markdown-toc-disclosure"
            aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
            aria-expanded={expanded}
            onClick={() => onToggleCollapsed(item.id)}
          >
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
          </button>
        ) : null}
        <button
          type="button"
          className="markdown-toc-title-button"
          onClick={() => onNavigate(item.id)}
        >
          <span className="markdown-toc-title">{item.title}</span>
        </button>
      </div>
      {hasChildren && expanded
        ? item.children.map((child) => (
            <MarkdownTocRow
              key={child.id}
              collapsedIds={collapsedIds}
              depth={depth + 1}
              item={child}
              onNavigate={onNavigate}
              onToggleCollapsed={onToggleCollapsed}
            />
          ))
        : null}
    </>
  )
}

export function MarkdownTableOfContentsPanel({
  items,
  onClose,
  onNavigate
}: MarkdownTableOfContentsPanelProps): React.JSX.Element {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setCollapsedIds((current) => pruneMarkdownTocCollapsedIds(current, items))
  }, [items])

  const collapseToLevel = (level: MarkdownTocLevel): void => {
    setCollapsedIds(collapseMarkdownTocToLevel(items, level))
  }

  const toggleCollapsed = (id: string): void => {
    setCollapsedIds((current) => toggleMarkdownTocCollapsedId(current, id))
  }

  return (
    <aside className="markdown-toc-panel" aria-label="Table of contents">
      <div className="markdown-toc-header">
        <ListTree className="size-3.5 text-muted-foreground" />
        <span>Table of Contents</span>
        <div className="markdown-toc-header-actions">
          <div className="markdown-toc-level-controls" role="group" aria-label="Collapse by level">
            {TOC_LEVELS.map((level) => (
              <Button
                key={level}
                type="button"
                variant="ghost"
                size="icon-xs"
                className="markdown-toc-level-button"
                aria-label={
                  level === 3 ? 'Expand all heading levels' : `Collapse to heading level ${level}`
                }
                title={level === 3 ? 'Expand all' : `Collapse to H${level}`}
                onClick={() => collapseToLevel(level)}
              >
                H{level}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Close table of contents"
            title="Close table of contents"
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="markdown-toc-list">
        {items.length > 0 ? (
          items.map((item) => (
            <MarkdownTocRow
              key={item.id}
              collapsedIds={collapsedIds}
              depth={0}
              item={item}
              onNavigate={onNavigate}
              onToggleCollapsed={toggleCollapsed}
            />
          ))
        ) : (
          <div className="markdown-toc-empty">No headings</div>
        )}
      </div>
    </aside>
  )
}
