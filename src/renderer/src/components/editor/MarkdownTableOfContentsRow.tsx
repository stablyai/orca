import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { MarkdownTocItem } from './markdown-table-of-contents'
import { isMarkdownTocItemExpanded } from './markdown-toc-collapse-state'

const TOC_INDENT_BASE_PX = 12
const TOC_INDENT_STEP_PX = 12

export function MarkdownTocRow({
  renderChildren = true,
  collapsedIds,
  depth,
  item,
  onNavigate,
  onToggleCollapsed
}: {
  renderChildren?: boolean
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
            aria-label={
              expanded
                ? translate(
                    'auto.components.editor.MarkdownTableOfContentsPanel.97ad46f11f',
                    'Collapse {{value0}}',
                    { value0: item.title }
                  )
                : translate(
                    'auto.components.editor.MarkdownTableOfContentsPanel.65b036a6c8',
                    'Expand {{value0}}',
                    { value0: item.title }
                  )
            }
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
      {renderChildren && hasChildren && expanded
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
