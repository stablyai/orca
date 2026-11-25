import { useMemo, useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MarkdownTocItem } from './markdown-table-of-contents'
import { isMarkdownTocItemExpanded } from './markdown-toc-collapse-state'

export function VirtualMarkdownTableOfContents({
  items,
  collapsedIds,
  renderRow
}: {
  items: MarkdownTocItem[]
  collapsedIds: ReadonlySet<string>
  renderRow: (item: MarkdownTocItem, depth: number) => ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => {
    const result: { item: MarkdownTocItem; depth: number }[] = []
    const visit = (entries: MarkdownTocItem[], depth: number): void => {
      for (const item of entries) {
        result.push({ item, depth })
        if (isMarkdownTocItemExpanded(collapsedIds, item)) {
          visit(item.children, depth + 1)
        }
      }
    }
    visit(items, 0)
    return result
  }, [items, collapsedIds])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 5,
    getItemKey: (index) => rows[index].item.id
  })
  return (
    <div ref={scrollRef} className="markdown-toc-list scrollbar-editor">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderRow(rows[row.index].item, rows[row.index].depth)}
          </div>
        ))}
      </div>
    </div>
  )
}
