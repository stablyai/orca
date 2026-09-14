import { createElement, useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, X } from 'lucide-react'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { basename } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { createFloatingTerminalPanelDragActions } from '../floating-terminal/floating-terminal-panel-drag-actions'
import {
  clampFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds
} from '../floating-terminal/floating-terminal-panel-bounds'
import { FloatingTerminalResizeHandles } from '../floating-terminal/FloatingTerminalResizeHandles'
import { FloatingFileContent } from './FloatingFileContent'
import { useFloatingFileViewers, type FloatingFileViewer } from './floating-file-viewer-state'

export function FloatingFileViewersToggle() {
  const count = useFloatingFileViewers((state) => state.viewers.length)
  const hidden = useFloatingFileViewers((state) => state.hidden)
  if (!count) {
    return null
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={!hidden}
      data-floating-file-viewers-toggle
      onClick={() => useFloatingFileViewers.getState().toggleHidden()}
    >
      {hidden ? <Eye /> : <EyeOff />}
      {hidden
        ? translate('floatingFileViewer.show', 'Show viewers')
        : translate('floatingFileViewer.hide', 'Hide viewers')}{' '}
      ({count})
    </Button>
  )
}

function FloatingFileWindow({
  viewer,
  visible,
  layer
}: {
  viewer: FloatingFileViewer
  visible: boolean
  layer: number
}) {
  const [bounds, setBounds] = useState(() => clampFloatingTerminalBounds(viewer.bounds))
  const staged = useRef(bounds)
  const restore = useRef<FloatingFileViewer['bounds'] | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const focusRequest = useFloatingFileViewers((state) => state.focusRequest)
  useEffect(() => {
    if (visible && useFloatingFileViewers.getState().viewers.at(-1)?.id === viewer.id) {
      panel.current?.focus({ preventScroll: true })
    }
  }, [focusRequest, viewer.id, visible])
  const dragRef =
    useRef<Parameters<typeof createFloatingTerminalPanelDragActions>[0]['dragRef']['current']>(null)
  const previewUserBounds = (next: FloatingFileViewer['bounds']) => {
    staged.current = clampFloatingTerminalBounds(next)
    setBounds(staged.current)
  }
  const commitUserBounds = () =>
    useFloatingFileViewers.getState().setBounds(viewer.id, staged.current)
  const drag = createFloatingTerminalPanelDragActions({
    bounds,
    maximized: false,
    dragRef,
    previewUserBounds,
    commitUserBounds,
    focusPanelForShortcuts: () => panel.current?.focus({ preventScroll: true }),
    toggleMaximized: () => {
      const next = restore.current ?? getMaximizedFloatingTerminalBounds()
      restore.current = restore.current ? null : bounds
      previewUserBounds(next)
      commitUserBounds()
    }
  })
  useEffect(() => {
    const resize = () => {
      staged.current = clampFloatingTerminalBounds(staged.current)
      setBounds(staged.current)
      useFloatingFileViewers.getState().setBounds(viewer.id, staged.current)
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [viewer.id])
  const closeLabel = translate('floatingFileViewer.close', 'Close viewer')
  const source = `${viewer.projectName} · ${viewer.workspaceName}`
  const FileIcon = getFileTypeIcon(viewer.relativePath)
  return (
    <div
      ref={panel}
      role="region"
      aria-label={`${basename(viewer.filePath)} — ${source}`}
      tabIndex={-1}
      data-floating-file-viewer={viewer.id}
      data-worktree-id={viewer.worktreeId}
      className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-floating outline-none focus-within:border-ring"
      style={{
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
        zIndex: layer,
        display: visible ? undefined : 'none'
      }}
      onPointerDownCapture={(event) => {
        useFloatingFileViewers.getState().raise(viewer.id)
        if (
          event.target instanceof Element &&
          !event.target.closest('button,input,textarea,select,a,[contenteditable],.monaco-editor')
        ) {
          panel.current?.focus({ preventScroll: true })
        }
      }}
      onFocusCapture={() => useFloatingFileViewers.getState().raise(viewer.id)}
    >
      <div
        className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 active:cursor-grabbing"
        data-floating-file-viewer-titlebar
        onPointerDown={drag.handleDragStart}
        onPointerMove={drag.handleDragMove}
        onPointerUp={drag.handleDragEnd}
        onPointerCancel={drag.handleDragEnd}
        onDoubleClick={drag.handleTitlebarDoubleClick}
      >
        {createElement(FileIcon, { className: 'size-4 shrink-0 text-muted-foreground' })}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="min-w-0 flex-1 truncate text-sm font-medium">
              {basename(viewer.filePath)}{' '}
              <span className="text-xs font-normal text-muted-foreground">— {source}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {source}
            <br />
            {viewer.filePath}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={closeLabel}
              className="shrink-0"
              onClick={() => useFloatingFileViewers.getState().close(viewer.id)}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-editor-surface">
        <FloatingFileContent viewer={viewer} visible={visible} />
      </div>
      <FloatingTerminalResizeHandles
        bounds={bounds}
        onPreviewBounds={previewUserBounds}
        onCommitBounds={commitUserBounds}
      />
    </div>
  )
}

export function FloatingFileViewers() {
  const viewers = useFloatingFileViewers((state) => state.viewers)
  const hidden = useFloatingFileViewers((state) => state.hidden)
  const inMultiplexer = useAppStore((state) => state.activeView === 'multiplexer')
  return (
    <div className="pointer-events-none fixed inset-0 z-40" aria-hidden={hidden || !inMultiplexer}>
      {[...viewers]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((viewer) => (
          <FloatingFileWindow
            key={viewer.id}
            viewer={viewer}
            layer={viewers.indexOf(viewer)}
            visible={inMultiplexer && !hidden}
          />
        ))}
    </div>
  )
}
