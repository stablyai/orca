import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import './workflow-canvas.css'
import { toast } from 'sonner'
import {
  WORKFLOW_NODE_KINDS,
  type WorkflowNodeKind
} from '../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { addWorkflowNode, connectWorkflowNodes } from './workflow-editor-mutations'
import {
  flowConnectionKind,
  parseFlowEdgeId,
  toFlowEdges,
  toFlowNodes,
  type WorkflowFlowEdge,
  type WorkflowFlowNode
} from './workflow-flow-mapping'
import { WorkflowNodeCard } from './WorkflowNodeCard'
import { WORKFLOW_EDGE_TYPES } from './WorkflowEdges'
import { WorkflowCanvasContextMenu, type WorkflowContextTarget } from './WorkflowCanvasContextMenu'

export const WORKFLOW_NODE_DRAG_TYPE = 'application/x-orca-workflow-node'
const NODE_TYPES = { workflow: WorkflowNodeCard }
const GRID: [number, number] = [16, 16]

function isNodeKind(value: string): value is WorkflowNodeKind {
  return WORKFLOW_NODE_KINDS.some((kind) => kind === value)
}

export function WorkflowCanvas(): React.JSX.Element | null {
  const preset = useWorkflowEditorStore((state) => state.preset)
  const selection = useWorkflowEditorStore((state) => state.selection)
  const layer = useWorkflowEditorStore((state) => state.layer)
  const execution = useWorkflowEditorStore((state) => state.mode === 'execution')
  const commit = useWorkflowEditorStore((state) => state.commit)
  const checkpoint = useWorkflowEditorStore((state) => state.checkpoint)
  const select = useWorkflowEditorStore((state) => state.select)
  const flow = useReactFlow<WorkflowFlowNode, WorkflowFlowEdge>()
  const dragging = useRef(false)
  const [contextTarget, setContextTarget] = useState<WorkflowContextTarget>({
    kind: 'pane',
    position: { x: 0, y: 0 }
  })

  const nodes = useMemo(() => (preset ? toFlowNodes(preset, selection) : []), [preset, selection])
  const edges = useMemo(() => {
    const mapped = preset ? toFlowEdges(preset, selection, layer) : []
    return mapped.map((edge) => ({
      ...edge,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: edge.selected ? 'var(--ring)' : 'var(--muted-foreground)'
      }
    }))
  }, [preset, selection, layer])

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      const moves = changes.filter((change) => change.type === 'position' && change.position)
      if (moves.length > 0) {
        if (!dragging.current) {
          dragging.current = true
          checkpoint()
        }
        commit(
          (draft) => {
            for (const change of moves) {
              if (change.type === 'position' && change.position) {
                draft.layout.positions[change.id] = {
                  x: Math.round(change.position.x),
                  y: Math.round(change.position.y)
                }
              }
            }
          },
          { history: false }
        )
      }
      if (changes.some((change) => change.type === 'position' && change.dragging === false)) {
        dragging.current = false
      }
      const selected = changes.filter((change) => change.type === 'select')
      if (selected.length > 0) {
        const prior = useWorkflowEditorStore.getState().selection
        const current = new Set(prior?.kind === 'nodes' ? prior.ids : [])
        for (const change of selected) {
          if (change.type === 'select') {
            if (change.selected) {
              current.add(change.id)
            } else {
              current.delete(change.id)
            }
          }
        }
        const previous = useWorkflowEditorStore.getState().selection
        if (current.size > 0) {
          select({ kind: 'nodes', ids: [...current] })
        } else if (previous?.kind === 'nodes') {
          select(null)
        }
      }
    },
    [checkpoint, commit, select]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<WorkflowFlowEdge>[]) => {
      const chosen = changes.find((change) => change.type === 'select' && change.selected)
      if (chosen && chosen.type === 'select') {
        const parsed = parseFlowEdgeId(chosen.id)
        if (parsed) {
          select({ kind: parsed.kind, id: parsed.id })
        }
      }
    },
    [select]
  )

  const isValidConnection: IsValidConnection<WorkflowFlowEdge> = useCallback(
    (connection) =>
      connection.source !== connection.target &&
      flowConnectionKind({
        sourceHandle: connection.sourceHandle ?? null,
        targetHandle: connection.targetHandle ?? null
      }) !== null,
    []
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const kind = flowConnectionKind(connection)
      if (!kind) {
        return
      }
      const outcome: { result: { id: string } | { error: string } } = { result: { error: '' } }
      commit((draft) => {
        outcome.result = connectWorkflowNodes(draft, kind, connection.source, connection.target)
      })
      const created = outcome.result
      if ('error' in created) {
        toast.error(created.error)
        return
      }
      select({ kind, id: created.id })
    },
    [commit, select]
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const kind = event.dataTransfer.getData(WORKFLOW_NODE_DRAG_TYPE)
      if (!isNodeKind(kind) || execution) {
        return
      }
      event.preventDefault()
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
      let id = ''
      commit((draft) => {
        id = addWorkflowNode(draft, kind, {
          x: Math.round(position.x / GRID[0]) * GRID[0],
          y: Math.round(position.y / GRID[1]) * GRID[1]
        })
      })
      select({ kind: 'nodes', ids: [id] })
    },
    [commit, execution, flow, select]
  )

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      commit(
        (draft) => {
          draft.layout.viewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
        },
        { history: false }
      )
    },
    [commit]
  )

  if (!preset) {
    return null
  }
  return (
    <WorkflowCanvasContextMenu target={contextTarget}>
      <div
        className="workflow-canvas relative size-full"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(WORKFLOW_NODE_DRAG_TYPE)) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={onDrop}
      >
        <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
          key={preset.id}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={WORKFLOW_EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onPaneClick={() => select(null)}
          onNodeContextMenu={(_event, node) => setContextTarget({ kind: 'node', id: node.id })}
          onEdgeContextMenu={(_event, edge) => {
            const parsed = parseFlowEdgeId(edge.id)
            if (parsed) {
              setContextTarget({ kind: parsed.kind, id: parsed.id })
            }
          }}
          onPaneContextMenu={(event) =>
            setContextTarget({
              kind: 'pane',
              position: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
            })
          }
          onMoveEnd={onMoveEnd}
          defaultViewport={preset.layout.viewport}
          // Saved presets reopen where the user left them; templates and new drafts open fitted.
          fitView={preset.template || useWorkflowEditorStore.getState().savedJson === null}
          fitViewOptions={{ padding: 0.12, maxZoom: 1, minZoom: 0.6 }}
          nodesDraggable={!execution}
          nodesConnectable={!execution}
          deleteKeyCode={null}
          multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
          snapToGrid
          snapGrid={GRID}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          connectionRadius={28}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <MiniMap
            pannable
            zoomable
            style={{ width: 168, height: 104 }}
            nodeStrokeWidth={2}
            nodeColor="color-mix(in srgb, var(--muted-foreground) 30%, transparent)"
            nodeStrokeColor="var(--border)"
            maskColor="color-mix(in srgb, var(--background) 55%, transparent)"
          />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>
    </WorkflowCanvasContextMenu>
  )
}
