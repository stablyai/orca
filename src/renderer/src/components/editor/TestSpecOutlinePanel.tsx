import React, { useEffect, useState } from 'react'
import { ChevronRight, ListTree, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TestOutlineNode } from './test-case-outline-parse'
import {
  isTestOutlineItemExpanded,
  pruneTestOutlineCollapsedIds,
  toggleTestOutlineCollapsedId
} from './test-spec-outline-collapse-state'

type TestSpecOutlinePanelProps = {
  items: TestOutlineNode[]
  onClose: () => void
  onNavigate: (line: number) => void
}

const OUTLINE_INDENT_BASE_PX = 12
const OUTLINE_INDENT_STEP_PX = 12

function TestOutlineRow({
  collapsedIds,
  depth,
  item,
  onNavigate,
  onToggleCollapsed
}: {
  collapsedIds: ReadonlySet<string>
  depth: number
  item: TestOutlineNode
  onNavigate: (line: number) => void
  onToggleCollapsed: (id: string) => void
}): React.JSX.Element {
  const hasChildren = item.children.length > 0
  const expanded = isTestOutlineItemExpanded(collapsedIds, item)
  const rowPaddingLeft = OUTLINE_INDENT_BASE_PX + depth * OUTLINE_INDENT_STEP_PX

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
                    'auto.components.editor.TestSpecOutlinePanel.97ad46f11f',
                    'Collapse {{value0}}',
                    { value0: item.title }
                  )
                : translate(
                    'auto.components.editor.TestSpecOutlinePanel.65b036b6c8',
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
          onClick={() => onNavigate(item.line)}
          title={translate(
            'auto.components.editor.TestSpecOutlinePanel.9c1e44a2d7',
            'Go to line {{value0}}',
            {
              value0: item.line
            }
          )}
        >
          <span
            className={cn(
              'markdown-toc-title',
              item.kind === 'describe' && 'font-medium',
              item.modifier === 'skip' && 'text-muted-foreground line-through',
              item.modifier === 'only' && 'font-semibold'
            )}
          >
            {item.title}
          </span>
          {item.modifier ? (
            <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">{item.modifier}</span>
          ) : null}
        </button>
      </div>
      {hasChildren && expanded
        ? item.children.map((child) => (
            <TestOutlineRow
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

/**
 * Renders a collapsible outline panel for navigating test cases within spec files.
 */
export function TestSpecOutlinePanel({
  items,
  onClose,
  onNavigate
}: TestSpecOutlinePanelProps): React.JSX.Element {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setCollapsedIds((current) => pruneTestOutlineCollapsedIds(current, items))
  }, [items])

  const toggleCollapsed = (id: string): void => {
    setCollapsedIds((current) => toggleTestOutlineCollapsedId(current, id))
  }

  return (
    <aside
      className="markdown-toc-panel w-64 flex-shrink-0 h-full overflow-hidden"
      aria-label={translate(
        'auto.components.editor.TestSpecOutlinePanel.27d0a9c49a',
        'Test case outline'
      )}
    >
      <div className="markdown-toc-header">
        <ListTree className="size-3.5 text-muted-foreground" />
        <span>
          {translate('auto.components.editor.TestSpecOutlinePanel.06357eea60', 'Test Outline')}
        </span>
        <div className="markdown-toc-header-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.editor.TestSpecOutlinePanel.bbe8369097',
              'Close test outline'
            )}
            title={translate(
              'auto.components.editor.TestSpecOutlinePanel.bbe8369097',
              'Close test outline'
            )}
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="markdown-toc-list scrollbar-sleek">
        {items.length > 0 ? (
          items.map((item) => (
            <TestOutlineRow
              key={item.id}
              collapsedIds={collapsedIds}
              depth={0}
              item={item}
              onNavigate={onNavigate}
              onToggleCollapsed={toggleCollapsed}
            />
          ))
        ) : (
          <div className="markdown-toc-empty">
            {translate(
              'auto.components.editor.TestSpecOutlinePanel.de3928b6e4',
              'No test cases found'
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
