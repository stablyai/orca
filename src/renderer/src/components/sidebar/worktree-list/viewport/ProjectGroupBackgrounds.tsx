import type { VirtualItem } from '@tanstack/react-virtual'
import { cn } from '@/lib/class-names'
import { getProjectGroupBackgroundStyle, type ProjectGroupColor } from './project-group-colors'

export function ProjectGroupHeaderBackground({
  style,
  isGroupHeader,
  collapsed
}: {
  style: React.CSSProperties | undefined
  isGroupHeader: boolean
  collapsed: boolean
}): React.JSX.Element | null {
  return style ? (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-y-0 right-1',
        isGroupHeader && 'rounded-t-md',
        isGroupHeader && collapsed && 'rounded-b-md'
      )}
      style={style}
    />
  ) : null
}

export function ProjectGroupBackgrounds({
  colors,
  virtualItems
}: {
  colors: readonly (ProjectGroupColor | null)[]
  virtualItems: readonly VirtualItem[]
}): React.JSX.Element {
  return (
    <>
      {virtualItems.map((item) => {
        const color = colors[item.index]
        if (!color) {
          return null
        }
        const first = colors[item.index - 1] !== color
        const last = colors[item.index + 1] !== color
        const topInset = first && item.index > 0 ? 4 : 0
        return (
          <div
            key={item.key}
            aria-hidden="true"
            data-project-group-background=""
            className={cn(
              'pointer-events-none absolute right-1',
              first && 'rounded-t-md',
              last && 'rounded-b-md'
            )}
            style={{
              top: item.start + topInset,
              height: Math.max(0, item.size - topInset - (last ? 4 : 0)),
              ...getProjectGroupBackgroundStyle(color)
            }}
          />
        )
      })}
    </>
  )
}
