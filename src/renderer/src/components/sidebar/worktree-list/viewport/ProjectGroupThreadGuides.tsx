import type { VirtualItem } from '@tanstack/react-virtual'
import type { LineageRowFrame } from '../listing/lineage-row-projection'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeVirtualRowContext } from '../rows/virtual-row-dispatch'
import { getProjectGroupHeaderPaddingLeft } from '../rows/indentation'
import { GROUP_HEADER_ROW_HEIGHT, GROUP_HEADER_ROW_BOTTOM_GAP } from './virtual-rows'

function getRailLeft(row: RenderRow, frame: LineageRowFrame): number {
  return row.type === 'header'
    ? getProjectGroupHeaderPaddingLeft(row.projectGroupDepth ?? 0) + 8
    : frame.left + frame.contentIndent + 8
}

export function ProjectGroupThreadGuides({
  context,
  virtualItems
}: {
  context: WorktreeVirtualRowContext
  virtualItems: readonly VirtualItem[]
}): React.JSX.Element {
  const { renderRows: rows, projection, projectGroupColors: colors } = context
  const { frames } = projection
  const { parents, lastChildren } = projection.projectGroupThreads
  return (
    <>
      {virtualItems.map((item) => {
        const row = rows[item.index]
        const frame = frames[item.index]
        if (!row || !frame) {
          return null
        }
        const isNode =
          row.type === 'header' || row.type === 'item' || row.type === 'folder-workspace'
        const anchor =
          row.type === 'header'
            ? item.size - GROUP_HEADER_ROW_BOTTOM_GAP - GROUP_HEADER_ROW_HEIGHT / 2
            : frame.before + 18
        const paths: { parent: number; d: string }[] = []
        let child = item.index
        let parent = parents[child] ?? null
        while (parent !== null) {
          const left = getRailLeft(rows[parent], frames[parent])
          const end = getRailLeft(row, frame) - 10
          const last = lastChildren[parent] === child
          if (child === item.index && isNode && end > left) {
            paths.push({
              parent,
              d: last
                ? `M${left} 0 V${anchor - 4} Q${left} ${anchor} ${left + 4} ${anchor} H${end}`
                : `M${left} 0 V${item.size} M${left} ${anchor} H${end}`
            })
          } else if ((!isNode || end > left) && child < (lastChildren[parent] ?? -1)) {
            paths.push({ parent, d: `M${left} 0 V${item.size}` })
          }
          child = parent
          parent = parents[parent]
        }
        const lastChild = lastChildren[item.index]
        if (
          lastChild != null &&
          getRailLeft(rows[lastChild], frames[lastChild]) - 10 > getRailLeft(row, frame)
        ) {
          const left = getRailLeft(row, frame)
          paths.push({ parent: item.index, d: `M${left} ${anchor + 8} V${item.size}` })
        }
        return paths.length > 0 ? (
          <svg
            key={item.key}
            aria-hidden="true"
            data-project-group-thread-guide={item.key}
            className="pointer-events-none absolute left-0 w-full"
            style={{ top: item.start, height: item.size }}
          >
            {paths.map(({ parent, d }) => {
              const color = colors?.[parent]?.color
              return (
                <path
                  key={parent}
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  style={{
                    color: color
                      ? `color-mix(in srgb, ${color} 55%, var(--border))`
                      : 'var(--border)'
                  }}
                />
              )
            })}
          </svg>
        ) : null
      })}
    </>
  )
}
