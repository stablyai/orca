import React, { useEffect, useRef, useState } from 'react'
import { Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import MermaidBlock from './MermaidBlock'
import {
  findMermaidSvg,
  mermaidDiagramCanExpand,
  prepareMermaidSvgForZoom,
  readMermaidSvgSize
} from './mermaid-svg-size'
import { useMermaidDiagramZoom } from './use-mermaid-diagram-zoom'

type ExpandableMermaidDiagramProps = {
  content: string
  isDark: boolean
  htmlLabels?: boolean
  className?: string
}

function MermaidZoomToolbar({
  canReset,
  canZoomIn,
  canZoomOut,
  onReset,
  onZoomIn,
  onZoomOut,
  zoomPercent
}: {
  canReset: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  onReset: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  zoomPercent: number
}): React.JSX.Element {
  const zoomOutLabel = translate(
    'auto.components.editor.MermaidDiagramLightbox.zoomOut',
    'Zoom out'
  )
  const resetLabel = translate(
    'auto.components.editor.MermaidDiagramLightbox.resetZoom',
    'Reset zoom'
  )
  const zoomInLabel = translate('auto.components.editor.MermaidDiagramLightbox.zoomIn', 'Zoom in')

  return (
    <div className="flex items-center gap-1 text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={zoomOutLabel}
            disabled={!canZoomOut}
            onClick={onZoomOut}
          >
            <ZoomOut />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {zoomOutLabel}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={resetLabel}
            disabled={!canReset}
            onClick={onReset}
          >
            <RotateCcw />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {resetLabel}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={zoomInLabel}
            disabled={!canZoomIn}
            onClick={onZoomIn}
          >
            <ZoomIn />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {zoomInLabel}
        </TooltipContent>
      </Tooltip>
      <span className="ml-1 min-w-10 text-xs tabular-nums">{zoomPercent}%</span>
    </div>
  )
}

function MermaidDiagramLightbox({
  content,
  htmlLabels,
  isDark
}: {
  content: string
  htmlLabels: boolean
  isDark: boolean
}): React.JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null)
  const title = translate('auto.components.editor.MermaidDiagramLightbox.title', 'Diagram')
  const closeLabel = translate('auto.components.editor.MermaidDiagramLightbox.close', 'Close')
  const {
    canReset,
    canZoomIn,
    canZoomOut,
    layoutStyle,
    resetZoom,
    setDiagramSize,
    setSurfaceNode,
    zoomIn,
    zoomOut,
    zoomPercent
  } = useMermaidDiagramZoom()

  useEffect(() => {
    const root = canvasRef.current
    if (!root) {
      return
    }

    const syncSvg = (): void => {
      const svg = findMermaidSvg(root)
      if (!svg) {
        setDiagramSize(null)
        return
      }
      const size = readMermaidSvgSize(svg)
      prepareMermaidSvgForZoom(svg)
      setDiagramSize(size)
    }

    syncSvg()
    const observer = new MutationObserver(syncSvg)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [content, htmlLabels, isDark, setDiagramSize])

  return (
    <DialogContent
      showCloseButton={false}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        if (event.currentTarget instanceof HTMLElement) {
          event.currentTarget.focus()
        }
      }}
      className="flex h-[92dvh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[96vw]"
    >
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <DialogDescription className="sr-only">
        {translate(
          'auto.components.editor.MermaidDiagramLightbox.preview',
          'Full-screen diagram preview. Pinch or hold Ctrl and scroll to zoom. Scroll to pan.'
        )}
      </DialogDescription>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
        <div className="flex shrink-0 items-center gap-2">
          <MermaidZoomToolbar
            canReset={canReset}
            canZoomIn={canZoomIn}
            canZoomOut={canZoomOut}
            onReset={resetZoom}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            zoomPercent={zoomPercent}
          />
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={closeLabel}>
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
      </div>
      <div
        ref={setSurfaceNode}
        className="min-h-0 flex-1 cursor-grab overflow-auto bg-muted/20 scrollbar-editor active:cursor-grabbing"
      >
        <div className="flex h-max min-h-full w-max min-w-full items-center justify-center p-4">
          <div
            ref={canvasRef}
            className="mermaid-diagram-lightbox-canvas flex items-center justify-center"
            style={layoutStyle}
          >
            <MermaidBlock content={content} htmlLabels={htmlLabels} isDark={isDark} />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center border-t border-border px-3 py-2 text-xs text-muted-foreground">
        {translate(
          'auto.components.editor.MermaidDiagramLightbox.escToClose',
          'Press Esc to close'
        )}
      </div>
    </DialogContent>
  )
}

export function ExpandableMermaidDiagram({
  content,
  isDark,
  htmlLabels = false,
  className
}: ExpandableMermaidDiagramProps): React.JSX.Element {
  const inlineRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const expandLabel = translate(
    'auto.components.editor.MermaidDiagramLightbox.expand',
    'Expand diagram'
  )

  useEffect(() => {
    const root = inlineRef.current
    if (!root) {
      return
    }
    const sync = (): void => setCanExpand(mermaidDiagramCanExpand(root))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [content, htmlLabels, isDark])

  return (
    <div className={cn('group/mermaid-diagram relative min-w-0 max-w-full', className)}>
      <Dialog open={open} onOpenChange={setOpen}>
        {canExpand ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label={expandLabel}
                  className="absolute top-2 right-2 z-10 bg-background/90 text-muted-foreground shadow-xs transition-opacity can-hover:opacity-0 group-focus-within/mermaid-diagram:opacity-100 group-hover/mermaid-diagram:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                  }}
                >
                  <Maximize2 />
                </Button>
              </DialogTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {expandLabel}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {open ? (
          <MermaidDiagramLightbox content={content} htmlLabels={htmlLabels} isDark={isDark} />
        ) : null}
      </Dialog>
      <div ref={inlineRef} className="overflow-x-auto">
        <MermaidBlock content={content} htmlLabels={htmlLabels} isDark={isDark} />
      </div>
    </div>
  )
}
