import { useCallback, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { DragOverlay, useDndContext } from '@dnd-kit/core'
import { ArrowDownUp } from 'lucide-react'
import { cloneSidebarDragSource } from './worktree-list/drag/worktree-sidebar-pointer-drag-dom'

const HEADER_PREVIEW_Z_INDEX = 999

export function SidebarSectionDragOverlay({
  sidebarStyle
}: {
  sidebarStyle?: CSSProperties
}): React.JSX.Element {
  const { active, activeNode, over } = useDndContext()
  const swapTarget = active && over && active.id !== over.id ? over.rect : null
  const previewRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !activeNode) {
        return
      }
      const clone = cloneSidebarDragSource(activeNode, [
        'data-sidebar-section',
        'data-sidebar-section-header',
        'data-sidebar-section-fold',
        'data-sidebar-section-title',
        'data-contextual-tour-target'
      ])
      clone.classList.remove('mt-2', 'opacity-0', 'pointer-events-none')
      node.replaceChildren(clone)
    },
    [activeNode]
  )

  return createPortal(
    <>
      <DragOverlay
        className="pointer-events-none rounded-md bg-worktree-sidebar shadow-xs ring-1 ring-worktree-sidebar-border"
        style={sidebarStyle}
        dropAnimation={null}
        zIndex={HEADER_PREVIEW_Z_INDEX}
      >
        {activeNode ? <div ref={previewRef} aria-hidden="true" inert /> : null}
      </DragOverlay>
      {swapTarget ? (
        <span
          aria-hidden="true"
          className="pointer-events-none fixed grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-worktree-sidebar text-worktree-sidebar-foreground ring-1 ring-worktree-sidebar-ring"
          style={{
            ...sidebarStyle,
            left: (swapTarget.left + swapTarget.right) / 2,
            top: swapTarget.top,
            zIndex: HEADER_PREVIEW_Z_INDEX + 1
          }}
        >
          <ArrowDownUp className="size-3" />
        </span>
      ) : null}
    </>,
    document.body
  )
}
