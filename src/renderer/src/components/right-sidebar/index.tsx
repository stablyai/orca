import React, { useCallback, useRef, useEffect } from 'react'
import { useAppStore } from '@/store'
import FileExplorer from './FileExplorer'
import SourceControl from './SourceControl'

const MIN_WIDTH = 220
const MAX_WIDTH = 500

export default function RightSidebar(): React.JSX.Element {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)

  // ─── Resize logic (handle on LEFT edge) ────────────
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing.current) return
      // Dragging left = larger width (opposite of left sidebar)
      const delta = startX.current - e.clientX
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta))
      setRightSidebarWidth(next)
    },
    [setRightSidebarWidth]
  )

  const handleMouseUp = useCallback(() => {
    isResizing.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isResizing.current = true
      startX.current = e.clientX
      startWidth.current = rightSidebarWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [rightSidebarWidth]
  )

  return (
    <div
      className="relative flex-shrink-0 bg-sidebar flex flex-col overflow-hidden transition-[width] duration-200"
      style={{
        width: rightSidebarOpen ? rightSidebarWidth : 0,
        borderLeft: rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
      }}
    >
      {/* Tab switcher header */}
      <div className="flex items-center border-b border-border h-[33px] min-h-[33px]">
        <TabButton
          label="Explorer"
          active={rightSidebarTab === 'explorer'}
          onClick={() => setRightSidebarTab('explorer')}
        />
        <TabButton
          label="Source Control"
          active={rightSidebarTab === 'source-control'}
          onClick={() => setRightSidebarTab('source-control')}
        />
      </div>

      {/* Tab content – key on worktreeId forces remount so stale file trees don't persist */}
      <div className="flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
        {rightSidebarTab === 'explorer' ? (
          <FileExplorer key={activeWorktreeId ?? 'none'} />
        ) : (
          <SourceControl key={activeWorktreeId ?? 'none'} />
        )}
      </div>

      {/* Resize handle on LEFT side */}
      <div
        className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10"
        onMouseDown={onResizeStart}
      />
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      className={`flex-1 text-[11px] font-semibold uppercase tracking-wider py-2 px-3 transition-colors ${
        active
          ? 'text-foreground border-b-2 border-foreground'
          : 'text-muted-foreground hover:text-foreground'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
