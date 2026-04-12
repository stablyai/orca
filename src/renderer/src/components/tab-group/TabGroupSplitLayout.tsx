import { useCallback, useRef, useState } from 'react'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import TabGroupPanel from './TabGroupPanel'

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

function ResizeHandle({
  direction,
  containerRef,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  containerRef: React.RefObject<HTMLDivElement | null>
  onRatioChange: (ratio: number) => void
}): React.JSX.Element {
  const isHorizontal = direction === 'horizontal'
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) {
        return
      }
      setDragging(true)
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)

      const onPointerMove = (ev: PointerEvent): void => {
        const rect = container.getBoundingClientRect()
        const ratio = isHorizontal
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height
        onRatioChange(Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)))
      }

      const onPointerUp = (): void => {
        setDragging(false)
        target.releasePointerCapture(e.pointerId)
        target.removeEventListener('pointermove', onPointerMove)
        target.removeEventListener('pointerup', onPointerUp)
      }

      target.addEventListener('pointermove', onPointerMove)
      target.addEventListener('pointerup', onPointerUp)
    },
    [containerRef, isHorizontal, onRatioChange]
  )

  return (
    <div
      className={`shrink-0 ${isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'} ${
        dragging ? 'bg-accent' : 'bg-border hover:bg-accent/50'
      }`}
      onPointerDown={onPointerDown}
    />
  )
}

function SplitNode({
  node,
  worktreeId,
  focusedGroupId,
  hasSplitGroups
}: {
  node: TabGroupLayoutNode
  worktreeId: string
  focusedGroupId?: string
  hasSplitGroups: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(0.5)

  if (node.type === 'leaf') {
    return (
      <TabGroupPanel
        groupId={node.groupId}
        worktreeId={worktreeId}
        isFocused={node.groupId === focusedGroupId}
        hasSplitGroups={hasSplitGroups}
      />
    )
  }

  const isHorizontal = node.direction === 'horizontal'

  return (
    <div
      ref={containerRef}
      className="flex flex-1 min-w-0 min-h-0 overflow-hidden"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div className="flex min-w-0 min-h-0 overflow-hidden" style={{ flex: `${ratio} 1 0%` }}>
        <SplitNode
          node={node.first}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          hasSplitGroups={hasSplitGroups}
        />
      </div>
      <ResizeHandle
        direction={isHorizontal ? 'horizontal' : 'vertical'}
        containerRef={containerRef}
        onRatioChange={setRatio}
      />
      <div className="flex min-w-0 min-h-0 overflow-hidden" style={{ flex: `${1 - ratio} 1 0%` }}>
        <SplitNode
          node={node.second}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          hasSplitGroups={hasSplitGroups}
        />
      </div>
    </div>
  )
}

export default function TabGroupSplitLayout({
  layout,
  worktreeId,
  focusedGroupId
}: {
  layout: TabGroupLayoutNode
  worktreeId: string
  focusedGroupId?: string
}): React.JSX.Element {
  const hasSplitGroups = layout.type === 'split'

  return (
    <div className="flex flex-1 min-w-0 min-h-0 overflow-hidden">
      <SplitNode
        node={layout}
        worktreeId={worktreeId}
        focusedGroupId={focusedGroupId}
        hasSplitGroups={hasSplitGroups}
      />
    </div>
  )
}
