import React from 'react'
import { sidebarChildSpans } from '../listing/sidebar-geometry-slots'
import { renderWorktreeItemRow } from './item-row'
import type { WorktreeVirtualRowContext } from './virtual-row-dispatch'

export type LineageDescendantContext = Pick<WorktreeVirtualRowContext, 'geometry' | 'item'>
export function VirtualizedLineageDescendants({
  ctx,
  root
}: {
  ctx: LineageDescendantContext
  root: number
}): React.JSX.Element {
  const { model, boundaries, selected } = ctx.geometry
  const renderChildren = (children: readonly number[]): React.ReactNode =>
    sidebarChildSpans(model, children, selected, boundaries).map((span) => {
      if (span.type === 'spacer') {
        return (
          <div
            key={`spacer:${span.key}`}
            aria-hidden="true"
            data-lineage-virtual-spacer=""
            style={{ height: span.height }}
          />
        )
      }
      const node = model.nodes[span.node]!
      if (node.row.type !== 'item') {
        return null
      }
      return (
        <div
          key={node.key}
          data-lineage-virtual-item={node.row.rowKey}
          data-sidebar-geometry-node={node.key}
        >
          {renderWorktreeItemRow(
            ctx.item,
            node.row,
            true,
            node.children.length > 0 ? (
              <div className="space-y-1" data-lineage-virtual-children="">
                {renderChildren(node.children)}
              </div>
            ) : undefined
          )}
        </div>
      )
    })
  return (
    <div className="space-y-1" data-lineage-virtual-children="">
      {renderChildren(model.nodes[root]!.children)}
    </div>
  )
}
