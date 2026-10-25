import { type JSX, memo, useCallback, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { OpenFile } from '@/store/slices/editor'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { markdownDocumentKey } from './markdown-link-resolver'
import {
  buildMarkdownNoteGraph,
  MARKDOWN_NOTE_GRAPH_MAX_NODES,
  markdownNoteGraphSearchOptions,
  type MarkdownNoteGraph
} from './markdown-note-graph'
import { layoutMarkdownNoteGraph, type GraphPoint } from './markdown-note-graph-layout'
import {
  clientToViewPoint,
  viewBoxUnitsPerPixel,
  zoomViewBox,
  type ViewBox
} from './markdown-note-graph-viewport'
import {
  useMarkdownWorkspaceSearch,
  type MarkdownWorkspaceSearch
} from './use-markdown-workspace-search'

type MarkdownNoteGraphDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeFile: OpenFile
  markdownDocuments: MarkdownDocument[]
  onOpenDocument: (document: MarkdownDocument) => void
}

function noteGraphSearch(activeFilePath: string): MarkdownWorkspaceSearch<MarkdownNoteGraph> {
  return {
    options: (_documents, rootPath) => markdownNoteGraphSearchOptions(rootPath),
    interpret: (documents, result) => {
      const active = documents.find((document) => document.filePath === activeFilePath)
      return buildMarkdownNoteGraph(
        documents,
        result,
        MARKDOWN_NOTE_GRAPH_MAX_NODES,
        active ? markdownDocumentKey(active) : null
      )
    },
    empty: { nodes: [], edges: [], omittedNodes: 0 }
  }
}

export function MarkdownNoteGraphDialog({
  open,
  onOpenChange,
  ...props
}: MarkdownNoteGraphDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] sm:max-w-[90vw]">
        <DialogTitle>
          {translate('auto.components.editor.MarkdownNoteGraphDialog.title', 'Note graph')}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.editor.MarkdownNoteGraphDialog.description',
            'Notes in this workspace and the links between them. Scroll to zoom, drag to pan, click a note to open it.'
          )}
        </DialogDescription>
        {open ? (
          <div className="flex h-[65vh] min-h-0 flex-col">
            <MarkdownNoteGraphView
              {...props}
              onOpenDocument={(document) => {
                onOpenChange(false)
                props.onOpenDocument(document)
              }}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function MarkdownNoteGraphView({
  activeFile,
  markdownDocuments,
  onOpenDocument
}: Omit<MarkdownNoteGraphDialogProps, 'open' | 'onOpenChange'>): JSX.Element {
  const search = useMemo(() => noteGraphSearch(activeFile.filePath), [activeFile.filePath])
  const { state } = useMarkdownWorkspaceSearch(activeFile, markdownDocuments, search)
  const graph = state.status === 'ready' ? state.value : null
  const positions = useMemo(() => (graph ? layoutMarkdownNoteGraph(graph) : null), [graph])
  const fitted = useMemo(
    () => (positions ? fitViewBox([...positions.values()]) : null),
    [positions]
  )
  const [view, setView] = useState<{ fitted: ViewBox; box: ViewBox } | null>(null)
  const box = view && view.fitted === fitted ? view.box : fitted
  const drag = useRef<{ clientX: number; clientY: number; box: ViewBox } | null>(null)
  const openRef = useRef(onOpenDocument)
  openRef.current = onOpenDocument
  const openNode = useCallback((document: MarkdownDocument) => openRef.current(document), [])
  const activeKey = useMemo(() => {
    const active = markdownDocuments.find((document) => document.filePath === activeFile.filePath)
    return active ? markdownDocumentKey(active) : null
  }, [activeFile.filePath, markdownDocuments])

  if (state.status === 'error') {
    return (
      <div
        role="alert"
        className="flex flex-1 items-center justify-center text-sm text-destructive"
      >
        {state.message}
      </div>
    )
  }
  if (!graph || !positions || !box || !fitted) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {translate('auto.components.editor.MarkdownNoteGraphDialog.loading', 'Building graph…')}
      </div>
    )
  }
  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {translate(
          'auto.components.editor.MarkdownNoteGraphDialog.empty',
          'No linked notes in this workspace yet'
        )}
      </div>
    )
  }
  const endDrag = (): void => {
    drag.current = null
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <svg
        role="img"
        aria-label={translate('auto.components.editor.MarkdownNoteGraphDialog.title', 'Note graph')}
        className="min-h-0 flex-1 cursor-grab touch-none rounded-md border border-border bg-muted/30 active:cursor-grabbing"
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        onWheel={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const anchor = clientToViewPoint(box, rect, event.clientX, event.clientY)
          const next = zoomViewBox(box, fitted, event.deltaY, anchor)
          setView({ fitted, box: next })
          if (drag.current) {
            // Why: a pan in progress continues from the zoomed view instead of snapping back.
            drag.current = { clientX: event.clientX, clientY: event.clientY, box: next }
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { clientX: event.clientX, clientY: event.clientY, box }
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start) {
            return
          }
          const scale = viewBoxUnitsPerPixel(
            start.box,
            event.currentTarget.clientWidth,
            event.currentTarget.clientHeight
          )
          setView({
            fitted,
            box: {
              ...start.box,
              x: start.box.x - (event.clientX - start.clientX) * scale,
              y: start.box.y - (event.clientY - start.clientY) * scale
            }
          })
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <MarkdownNoteGraphLayer
          graph={graph}
          positions={positions}
          activeKey={activeKey}
          onOpenDocument={openNode}
        />
      </svg>
      <div className="text-xs text-muted-foreground">
        {translate(
          'auto.components.editor.MarkdownNoteGraphDialog.summary',
          '{{value0}} notes, {{value1}} links',
          { value0: graph.nodes.length, value1: graph.edges.length }
        )}
        {graph.omittedNodes > 0 || (state.status === 'ready' && state.truncated)
          ? ` · ${translate(
              'auto.components.editor.MarkdownNoteGraphDialog.partial',
              'Large workspace: showing the best-connected part of the graph'
            )}`
          : null}
      </div>
    </div>
  )
}

// Why memo: pan and zoom only change the viewBox, so hundreds of nodes must not re-render per move.
const MarkdownNoteGraphLayer = memo(function MarkdownNoteGraphLayer({
  graph,
  positions,
  activeKey,
  onOpenDocument
}: {
  graph: MarkdownNoteGraph
  positions: Map<string, GraphPoint>
  activeKey: string | null
  onOpenDocument: (document: MarkdownDocument) => void
}): JSX.Element {
  return (
    <>
      <g className="stroke-border">
        {graph.edges.map((edge) => {
          const a = positions.get(edge.source)
          const b = positions.get(edge.target)
          return a && b ? (
            <line
              key={`${edge.source}\n${edge.target}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              strokeWidth={1}
            />
          ) : null
        })}
      </g>
      {graph.nodes.map((node) => {
        const point = positions.get(node.key)
        if (!point) {
          return null
        }
        const radius = 4 + Math.sqrt(node.degree) * 2
        const isActive = node.key === activeKey
        return (
          <g
            key={node.key}
            role="button"
            tabIndex={0}
            aria-label={node.document.relativePath}
            className="cursor-pointer outline-none"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onOpenDocument(node.document)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onOpenDocument(node.document)
              }
            }}
          >
            <title>{node.document.relativePath}</title>
            <circle
              cx={point.x}
              cy={point.y}
              r={radius}
              className={isActive ? 'fill-primary' : 'fill-muted-foreground'}
            />
            <text
              x={point.x}
              y={point.y + radius + 10}
              textAnchor="middle"
              fontSize={10}
              className={isActive ? 'fill-foreground font-medium' : 'fill-muted-foreground'}
            >
              {node.document.name}
            </text>
          </g>
        )
      })}
    </>
  )
})

// Why a minimum: a handful of notes would otherwise be scaled up to fill the dialog.
const MIN_VIEW_SIZE = 800

function fitViewBox(points: { x: number; y: number }[]): ViewBox {
  const padding = 40
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs, 0)
  const minY = Math.min(...ys, 0)
  const maxX = Math.max(...xs, 0)
  const maxY = Math.max(...ys, 0)
  const width = Math.max(maxX - minX + padding * 2, MIN_VIEW_SIZE)
  const height = Math.max(maxY - minY + padding * 2, MIN_VIEW_SIZE / 2)
  return {
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    width,
    height
  }
}
