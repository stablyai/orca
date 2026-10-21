import { MarkdownTocRow } from './MarkdownTableOfContentsRow'
import { VirtualMarkdownTableOfContents } from './VirtualMarkdownTableOfContents'
import React, { useEffect, useState } from 'react'
import { ListTree, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MarkdownTocItem, MarkdownTocLevel } from './markdown-table-of-contents'
import {
  collapseMarkdownTocToLevel,
  pruneMarkdownTocCollapsedIds,
  toggleMarkdownTocCollapsedId
} from './markdown-toc-collapse-state'
import { translate } from '@/i18n/i18n'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useAppStore } from '@/store'
import {
  MARKDOWN_TOC_PANEL_MIN_WIDTH,
  MARKDOWN_TOC_RESIZE_HANDLE_CLASS_NAME,
  clampMarkdownTocPanelWidth,
  computeMaxMarkdownTocPanelWidth
} from './markdown-toc-panel-width'

type MarkdownTableOfContentsPanelProps = {
  virtualized?: boolean
  items: MarkdownTocItem[]
  onClose: () => void
  onNavigate: (id: string) => void
}

const TOC_LEVELS: MarkdownTocLevel[] = [1, 2, 3, 4, 5]
const TOC_EXPAND_ALL_LEVEL: MarkdownTocLevel = 5

export function MarkdownTableOfContentsPanel({
  virtualized = false,
  items,
  onClose,
  onNavigate
}: MarkdownTableOfContentsPanelProps): React.JSX.Element {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const markdownTocPanelWidth = useAppStore((s) => s.markdownTocPanelWidth)
  const setMarkdownTocPanelWidth = useAppStore((s) => s.setMarkdownTocPanelWidth)
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null)
  const maxPanelWidth = computeMaxMarkdownTocPanelWidth(layoutWidth ?? 0)
  const renderedPanelWidth = clampMarkdownTocPanelWidth(
    markdownTocPanelWidth,
    layoutWidth ?? undefined
  )
  const { containerRef, onResizeStart } = useSidebarResize<HTMLElement>({
    isOpen: true,
    width: renderedPanelWidth,
    minWidth: MARKDOWN_TOC_PANEL_MIN_WIDTH,
    maxWidth: maxPanelWidth,
    deltaSign: 1,
    setWidth: setMarkdownTocPanelWidth
  })

  useEffect(() => {
    setCollapsedIds((current) => pruneMarkdownTocCollapsedIds(current, items))
  }, [items])

  useEffect(() => {
    const container = containerRef.current
    const layout = container?.parentElement
    if (!layout) {
      return
    }

    const updateMaxWidth = (): void => {
      setLayoutWidth(layout.clientWidth)
    }

    updateMaxWidth()
    const observer = new ResizeObserver(updateMaxWidth)
    observer.observe(layout)
    return () => observer.disconnect()
  }, [containerRef])

  const collapseToLevel = (level: MarkdownTocLevel): void => {
    setCollapsedIds(collapseMarkdownTocToLevel(items, level))
  }

  const toggleCollapsed = (id: string): void => {
    setCollapsedIds((current) => toggleMarkdownTocCollapsedId(current, id))
  }

  return (
    <aside
      ref={containerRef}
      className="markdown-toc-panel"
      aria-label={translate(
        'auto.components.editor.MarkdownTableOfContentsPanel.27d0a9c49a',
        'Table of contents'
      )}
    >
      <div className="markdown-toc-header">
        <ListTree className="size-3.5 text-muted-foreground" />
        <span>
          {translate(
            'auto.components.editor.MarkdownTableOfContentsPanel.06357eea60',
            'Table of Contents'
          )}
        </span>
        <div className="markdown-toc-header-actions">
          <div
            className="markdown-toc-level-controls"
            role="group"
            aria-label={translate(
              'auto.components.editor.MarkdownTableOfContentsPanel.0dc7b2f05a',
              'Collapse by level'
            )}
          >
            {TOC_LEVELS.map((level) => (
              <Button
                key={level}
                type="button"
                variant="ghost"
                size="icon-xs"
                className="markdown-toc-level-button"
                aria-label={
                  level === TOC_EXPAND_ALL_LEVEL
                    ? translate(
                        'auto.components.editor.MarkdownTableOfContentsPanel.f3de856175',
                        'Expand all heading levels'
                      )
                    : translate(
                        'auto.components.editor.MarkdownTableOfContentsPanel.111e66b85d',
                        'Collapse to heading level {{value0}}',
                        { value0: level }
                      )
                }
                title={
                  level === TOC_EXPAND_ALL_LEVEL
                    ? translate(
                        'auto.components.editor.MarkdownTableOfContentsPanel.a5daadd68b',
                        'Expand all'
                      )
                    : translate(
                        'auto.components.editor.MarkdownTableOfContentsPanel.4680a4b808',
                        'Collapse to H{{value0}}',
                        { value0: level }
                      )
                }
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
            aria-label={translate(
              'auto.components.editor.MarkdownTableOfContentsPanel.bbe8369097',
              'Close table of contents'
            )}
            title={translate(
              'auto.components.editor.MarkdownTableOfContentsPanel.bbe8369097',
              'Close table of contents'
            )}
            onClick={onClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      {virtualized && items.length > 0 ? (
        <VirtualMarkdownTableOfContents
          items={items}
          collapsedIds={collapsedIds}
          renderRow={(item, depth) => (
            <MarkdownTocRow
              item={item}
              depth={depth}
              collapsedIds={collapsedIds}
              onNavigate={onNavigate}
              onToggleCollapsed={toggleCollapsed}
              renderChildren={false}
            />
          )}
        />
      ) : (
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
            <div className="markdown-toc-empty">
              {translate(
                'auto.components.editor.MarkdownTableOfContentsPanel.de3928b6e4',
                'No headings'
              )}
            </div>
          )}
        </div>
      )}
      <div
        data-markdown-toc-resize-handle=""
        className={MARKDOWN_TOC_RESIZE_HANDLE_CLASS_NAME}
        role="separator"
        aria-orientation="vertical"
        aria-label={translate(
          'auto.components.editor.MarkdownTableOfContentsPanel.8f4d2c1a9b',
          'Resize table of contents'
        )}
        onMouseDown={onResizeStart}
      />
    </aside>
  )
}
