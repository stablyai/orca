import type { ReactNode } from 'react'
import { useDndContext } from '@dnd-kit/core'

/** Scroll fixed section minima in short windows while the bottom toolbar stays reachable. */
export function SidebarContentViewport({ children }: { children: ReactNode }): React.JSX.Element {
  const { active } = useDndContext()
  return (
    <div
      data-sidebar-content-viewport=""
      className="worktree-sidebar-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto [overflow-anchor:none]"
      style={active ? { scrollbarColor: 'transparent transparent' } : undefined}
    >
      {children}
    </div>
  )
}
