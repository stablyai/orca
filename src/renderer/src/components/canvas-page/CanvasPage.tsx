import { useCallback, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Frame } from 'lucide-react'
import type { CanvasCard } from '@/store/slices/canvas'
import {
  CANVAS_DEFAULT_CARD_HEIGHT,
  CANVAS_DEFAULT_CARD_WIDTH,
  classifyCanvasFile
} from '@/store/slices/canvas'
import { useAppStore } from '@/store'
import { decodeWorkspaceFilePaths } from '@/lib/workspace-file-drag'
import { translate } from '@/i18n/i18n'
import { CanvasCardNode, type CanvasFlowNode } from './CanvasCardView'

const EMPTY_CARDS: CanvasCard[] = []
const nodeTypes = { canvasCard: CanvasCardNode }

function CanvasFlowSurface({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const cards = useAppStore((s) => s.canvasCardsByWorktree[worktreeId] ?? EMPTY_CARDS)
  const addCanvasCard = useAppStore((s) => s.addCanvasCard)
  const removeCanvasCard = useAppStore((s) => s.removeCanvasCard)
  const updateCanvasCardGeometry = useAppStore((s) => s.updateCanvasCardGeometry)
  const setCanvasViewport = useAppStore((s) => s.setCanvasViewport)
  const theme = useAppStore((s) => s.settings?.theme)
  const { screenToFlowPosition } = useReactFlow()

  const nodes = useMemo<CanvasFlowNode[]>(
    () =>
      cards.map((card) => ({
        id: card.id,
        type: 'canvasCard' as const,
        position: { x: card.x, y: card.y },
        data: { card },
        // Why both: explicit dimensions let xyflow place the node without waiting for a DOM
        // measure pass, which never arrives in a hidden (background-launched) window.
        width: card.width,
        height: card.height,
        style: { width: card.width, height: card.height },
        dragHandle: '.canvas-card-header'
      })),
    [cards]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]): void => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          updateCanvasCardGeometry(worktreeId, change.id, change.position)
        } else if (change.type === 'dimensions' && change.dimensions && !change.resizing) {
          updateCanvasCardGeometry(worktreeId, change.id, {
            width: change.dimensions.width,
            height: change.dimensions.height
          })
        } else if (change.type === 'remove') {
          removeCanvasCard(worktreeId, change.id)
        }
      }
    },
    [removeCanvasCard, updateCanvasCardGeometry, worktreeId]
  )

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    const data =
      event.dataTransfer.getData('text/x-orca-file-paths') ||
      event.dataTransfer.getData('text/x-orca-file-path')
    if (!data) {
      return
    }
    event.preventDefault()
    const anchor = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    decodeWorkspaceFilePaths(data).forEach((path, index) => {
      if (!classifyCanvasFile(path)) {
        return
      }
      addCanvasCard(worktreeId, {
        filePath: path,
        x: anchor.x - CANVAS_DEFAULT_CARD_WIDTH / 2 + index * 24,
        y: anchor.y - 24 + index * 24,
        width: CANVAS_DEFAULT_CARD_WIDTH,
        height: CANVAS_DEFAULT_CARD_HEIGHT
      })
    })
  }

  const onDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (
      event.dataTransfer.types.includes('text/x-orca-file-path') ||
      event.dataTransfer.types.includes('text/x-orca-file-paths')
    ) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  // Why getState once: remounted per worktree (keyed provider), so this reads the saved viewport exactly at mount.
  const initialViewport = useMemo(() => {
    const saved = useAppStore.getState().canvasViewportByWorktree[worktreeId]
    return saved ? { x: saved.offsetX, y: saved.offsetY, zoom: saved.zoom } : undefined
  }, [worktreeId])

  return (
    <div className="relative min-h-0 flex-1" onDrop={onDrop} onDragOver={onDragOver}>
      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        defaultViewport={initialViewport}
        onMoveEnd={(_event, viewport) =>
          setCanvasViewport(worktreeId, {
            offsetX: viewport.x,
            offsetY: viewport.y,
            zoom: viewport.zoom
          })
        }
        minZoom={0.25}
        maxZoom={2.5}
        // Why: wheel pans, Ctrl/Cmd+wheel (and pinch) zooms — the Figma-style mapping.
        panOnScroll
        zoomOnScroll={false}
        deleteKeyCode={['Backspace', 'Delete']}
        colorMode={theme === 'dark' || theme === 'light' ? theme : 'system'}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {cards.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
          <Frame className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground">
            {translate('auto.components.canvas-page.emptyTitle', 'This canvas is empty')}
          </p>
          <p className="max-w-sm text-center text-xs text-muted-foreground/80">
            {translate(
              'auto.components.canvas-page.emptyHint',
              'Drag Markdown or HTML files from the Explorer onto the canvas to preview them side by side.'
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}

export default function CanvasPage(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  if (!activeWorktreeId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
        <Frame className="size-8 text-muted-foreground/40" strokeWidth={1.5} />
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.canvas-page.noWorkspace',
            'Open a workspace to use the canvas.'
          )}
        </p>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Frame className="size-4 text-muted-foreground" strokeWidth={1.75} />
        <span className="text-[13px] font-medium">
          {translate('auto.components.canvas-page.title', 'Canvas')}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {translate(
            'auto.components.canvas-page.hint',
            'Drag .md or .html files here from the Explorer to pin them as cards.'
          )}
        </span>
      </div>
      {/* Why keyed + provider inside: switching workspaces remounts the flow so defaultViewport re-reads that workspace's saved viewport. */}
      <ReactFlowProvider key={activeWorktreeId}>
        <CanvasFlowSurface worktreeId={activeWorktreeId} />
      </ReactFlowProvider>
    </div>
  )
}
