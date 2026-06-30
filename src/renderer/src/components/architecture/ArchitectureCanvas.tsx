/* eslint-disable max-lines -- Why: this canvas still owns selection, drill-in, edge editing, and layout wiring until the remaining Scryer panel logic is split out. */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal
} from '@xyflow/react'
import type {
  Connection,
  DefaultEdgeOptions,
  OnEdgesChange,
  OnConnect,
  OnNodesChange
} from '@xyflow/react'
import { Bot, ChevronRight, LayoutGrid, Maximize, Minus, Plus, Trash2, ZoomIn } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import type {
  ArchitectureDiagramModel,
  ArchitectureDiagramNode,
  ArchitectureSourceLocation
} from './architecture-diagram-types'
import {
  applyNodePositionChangesToModel,
  getVisibleGroupBubbles,
  getVisibleArchitectureView
} from './architecture-diagram-model'
import { Button } from '../ui/button'
import { edgeTypes, type ArchitectureFlowEdge } from './edges'
import { autoLayoutVisibleNodes, decorateEdgesForRouting } from './layout/architecture-layout'
import { nodeTypes, type ArchitectureFlowNode } from './nodes'
import { createArchitecturePerformanceRecorder } from './architecture-performance'

type ArchitectureCanvasProps = {
  model: ArchitectureDiagramModel
  syncing: boolean
  expandedPath: string[]
  selectedNodeId: string | null
  selectedEdgeId: string | null
  multiSelectedNodeIds: string[]
  changedNodeIds: Set<string>
  driftedNodeIds: Set<string>
  onExpandedPathChange: (path: string[]) => void
  onSelectedNodeChange: (nodeId: string | null) => void
  onSelectedEdgeChange: (edgeId: string | null) => void
  onMultiSelectionChange: (nodeIds: string[], totalSelected: number) => void
  onModelChange: (
    change: ArchitectureDiagramModel | ModelUpdater,
    message: string
  ) => void | Promise<void>
  onAddNode: () => void | Promise<void>
  onAddEdge: (sourceNodeId: string, targetNodeId: string) => void | Promise<void>
  onDeleteNode: (nodeId: string) => void | Promise<void>
  onDeleteEdge: (edgeId: string) => void | Promise<void>
  onOpenSourceLocation: (location: ArchitectureSourceLocation) => void | Promise<void>
  onFillNodeWithAi?: (nodeId: string) => void | Promise<void>
  onCreateGroupFromSelection?: (name: string) => void | Promise<void>
  onAddSelectionToGroup?: (groupId: string) => void | Promise<void>
}

export type ModelUpdater = (current: ArchitectureDiagramModel) => ArchitectureDiagramModel | null

const defaultEdgeOptions: DefaultEdgeOptions = {
  type: 'relationship'
}

const INITIAL_NODE_WIDTH = 180
const INITIAL_NODE_HEIGHT = 160

function sourceLocationsForNode(
  model: ArchitectureDiagramModel,
  nodeId: string
): ArchitectureSourceLocation[] {
  const locations = model.sourceMap?.[nodeId] ?? []
  const boundaryLocations =
    model.boundaries?.[nodeId]?.map((source) => ({
      pattern: source.pattern,
      ...(source.comment ? { command: source.comment } : {})
    })) ?? []
  return [...locations, ...boundaryLocations]
}

export function ArchitectureCanvas(props: ArchitectureCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <ArchitectureCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function ArchitectureCanvasInner({
  model,
  syncing,
  expandedPath,
  selectedNodeId,
  selectedEdgeId,
  multiSelectedNodeIds,
  changedNodeIds,
  driftedNodeIds,
  onExpandedPathChange,
  onSelectedNodeChange,
  onSelectedEdgeChange,
  onMultiSelectionChange,
  onModelChange,
  onAddNode,
  onAddEdge,
  onDeleteNode,
  onDeleteEdge,
  onOpenSourceLocation,
  onFillNodeWithAi,
  onCreateGroupFromSelection,
  onAddSelectionToGroup
}: ArchitectureCanvasProps): React.JSX.Element {
  const suppressNativeSelectionRef = useRef(false)
  const reactFlow = useReactFlow<ArchitectureFlowNode, ArchitectureFlowEdge>()
  const performanceRecorder = useMemo(() => createArchitecturePerformanceRecorder(), [])
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    type: 'canvas' | 'node' | 'edge'
    nodeId?: string
    edgeId?: string
  } | null>(null)
  const view = useMemo(
    () => getVisibleArchitectureView({ model, expandedPath, changedNodeIds, driftedNodeIds }),
    [changedNodeIds, driftedNodeIds, expandedPath, model]
  )
  const selectedNode = selectedNodeId
    ? (model.nodes.find((node) => node.id === selectedNodeId) ?? null)
    : null
  const selectedEdge = selectedEdgeId
    ? (model.links.find((edge) => edge.id === selectedEdgeId) ?? null)
    : null
  const selectedVisibleNode = selectedNodeId
    ? (view.visibleNodes.find((node) => node.id === selectedNodeId) ?? null)
    : null

  const visibleNodes = useMemo<ArchitectureFlowNode[]>(
    () =>
      view.visibleNodes.map((node) =>
        toFlowNode(node, {
          selected: node.id === selectedNodeId || multiSelectedNodeIds.includes(node.id),
          data: {
            sourceLocations: sourceLocationsForNode(model, node.id),
            onExpand: () => onExpandedPathChange([...expandedPath, node.id]),
            onOpenSourceLocation
          }
        })
      ),
    [
      expandedPath,
      model,
      onExpandedPathChange,
      onOpenSourceLocation,
      selectedNodeId,
      multiSelectedNodeIds,
      view.visibleNodes
    ]
  )

  const visibleEdges = useMemo<ArchitectureFlowEdge[]>(
    () =>
      decorateEdgesForRouting(view.visibleNodes, view.visibleEdges).map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdgeId,
        type: 'relationship',
        data: {
          label: '',
          ...edge.data,
          _onSelect: onSelectedEdgeChange
        }
      })),
    [onSelectedEdgeChange, selectedEdgeId, view.visibleEdges, view.visibleNodes]
  )

  const groupBubbles = useMemo(
    () => getVisibleGroupBubbles(model, view.visibleNodes),
    [model, view.visibleNodes]
  )
  const showFillWithAi =
    !!view.currentParentId &&
    !syncing &&
    !!onFillNodeWithAi &&
    view.visibleNodes.every((node) => node.data._reference)
  const fillLabel =
    view.currentParentKind === 'system'
      ? 'containers'
      : view.currentParentKind === 'container'
        ? 'components'
        : 'children'

  const onNodesChange = useCallback<OnNodesChange<ArchitectureFlowNode>>(
    (changes) => {
      if (syncing) {
        return
      }
      const removedReferenceIds = changes.flatMap((change) =>
        change.type === 'remove' && 'id' in change && view.refNodeIds.has(change.id)
          ? [change.id]
          : []
      )
      const removedIds = changes.flatMap((change) =>
        change.type === 'remove' && 'id' in change && !view.refNodeIds.has(change.id)
          ? [change.id]
          : []
      )
      if (removedIds.length > 0 || removedReferenceIds.length > 0) {
        const referenceEdgeIds = model.links
          .filter(
            (link) =>
              view.currentParentId &&
              removedReferenceIds.some(
                (nodeId) =>
                  (link.source === view.currentParentId && link.target === nodeId) ||
                  (link.target === view.currentParentId && link.source === nodeId)
              )
          )
          .map((link) => link.id)
        void Promise.all([
          ...referenceEdgeIds.map((edgeId) => onDeleteEdge(edgeId)),
          ...removedIds.map((nodeId) => onDeleteNode(nodeId))
        ])
        return
      }
      void onModelChange(
        (current) =>
          applyNodePositionChangesToModel(current, changes, view.refNodeIds, view.currentParentId),
        'Saved canvas layout'
      )
    },
    [
      model.links,
      onDeleteEdge,
      onDeleteNode,
      onModelChange,
      syncing,
      view.currentParentId,
      view.refNodeIds
    ]
  )

  const onEdgesChange = useCallback<OnEdgesChange<ArchitectureFlowEdge>>(
    (changes) => {
      const selection = changes.find((change) => change.type === 'select' && change.selected)
      if (selection && 'id' in selection) {
        onSelectedEdgeChange(selection.id)
      }
      if (syncing) {
        return
      }
      const removedIds = new Set(
        changes.filter((change) => change.type === 'remove').map((change) => change.id)
      )
      if (removedIds.size > 0) {
        void Promise.all([...removedIds].map((edgeId) => onDeleteEdge(edgeId)))
        if (selectedEdgeId && removedIds.has(selectedEdgeId)) {
          onSelectedEdgeChange(null)
        }
      }
    },
    [onDeleteEdge, onSelectedEdgeChange, selectedEdgeId, syncing]
  )

  const onConnect = useCallback<OnConnect>(
    (connection: Connection) => {
      if (
        syncing ||
        !connection.source ||
        !connection.target ||
        connection.source === connection.target
      ) {
        return
      }
      void onAddEdge(connection.source, connection.target)
    },
    [onAddEdge, syncing]
  )

  const addNodeAtLevel = useCallback(() => {
    if (syncing) {
      return
    }
    void onAddNode()
  }, [onAddNode, syncing])

  const addNodeAtCanvasPoint = useCallback(
    (_clientX: number, _clientY: number) => {
      if (syncing) {
        return
      }
      void onAddNode()
      setContextMenu(null)
    },
    [onAddNode, syncing]
  )

  const deleteNodeFromMenu = useCallback(
    (nodeId: string) => {
      if (syncing) {
        return
      }
      void onDeleteNode(nodeId)
      onSelectedNodeChange(null)
      setContextMenu(null)
    },
    [onDeleteNode, onSelectedNodeChange, syncing]
  )

  const deleteEdgeFromMenu = useCallback(
    (edgeId: string) => {
      if (syncing) {
        return
      }
      void onDeleteEdge(edgeId)
      onSelectedEdgeChange(null)
      setContextMenu(null)
    },
    [onDeleteEdge, onSelectedEdgeChange, syncing]
  )

  const deleteSelected = useCallback(() => {
    if (syncing) {
      return
    }
    if (selectedVisibleNode?.data._reference) {
      const referenceEdgeIds = model.links
        .filter(
          (link) =>
            view.currentParentId &&
            ((link.source === view.currentParentId && link.target === selectedVisibleNode.id) ||
              (link.target === view.currentParentId && link.source === selectedVisibleNode.id))
        )
        .map((link) => link.id)
      void Promise.all(referenceEdgeIds.map((edgeId) => onDeleteEdge(edgeId)))
      onSelectedNodeChange(null)
      return
    }
    if (selectedNode) {
      void onDeleteNode(selectedNode.id)
      onSelectedNodeChange(null)
      return
    }
    if (selectedEdge) {
      void onDeleteEdge(selectedEdge.id)
      onSelectedEdgeChange(null)
    }
  }, [
    model.links,
    onDeleteEdge,
    onDeleteNode,
    onSelectedEdgeChange,
    onSelectedNodeChange,
    selectedEdge,
    selectedNode,
    selectedVisibleNode,
    syncing,
    view.currentParentId
  ])

  const autoLayout = useCallback(() => {
    if (syncing) {
      return
    }
    const layoutNodes = performanceRecorder.measure('auto-layout', () =>
      autoLayoutVisibleNodes(view.visibleNodes, view.visibleEdges, {
        codeLevel: view.currentParentKind === 'component',
        fullRelayout: true
      })
    )
    const positions = new Map(
      layoutNodes
        .filter((node) => !node.data._reference && node.position)
        .map((node) => [node.id, node.position!])
    )
    if (positions.size === 0) {
      return
    }
    void onModelChange((current) => {
      let changed = false
      const nodes = current.nodes.map((node) => {
        const position = positions.get(node.id)
        if (!position) {
          return node
        }
        if (node.position?.x === position.x && node.position.y === position.y) {
          return node
        }
        changed = true
        return { ...node, position }
      })
      return changed ? { ...current, nodes } : null
    }, 'Saved auto layout')
  }, [
    onModelChange,
    performanceRecorder,
    syncing,
    view.currentParentKind,
    view.visibleEdges,
    view.visibleNodes
  ])

  const navigateToRoot = useCallback(() => onExpandedPathChange([]), [onExpandedPathChange])
  const navigateToBreadcrumb = useCallback(
    (index: number) => onExpandedPathChange(expandedPath.slice(0, index + 1)),
    [expandedPath, onExpandedPathChange]
  )
  const expandNode = useCallback(
    (nodeId: string) => {
      const node = model.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.data.external || node.data._reference) {
        return
      }
      if (
        node.data.kind !== 'system' &&
        node.data.kind !== 'container' &&
        node.data.kind !== 'component'
      ) {
        return
      }
      onSelectedNodeChange(nodeId)
      onExpandedPathChange(
        expandedPath.at(-1) === nodeId ? expandedPath : [...expandedPath, nodeId]
      )
    },
    [expandedPath, model.nodes, onExpandedPathChange, onSelectedNodeChange]
  )

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden" data-testid="architecture-canvas">
      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={({ nodes, edges }) => {
          if (suppressNativeSelectionRef.current) {
            return
          }
          const realNodeIds = nodes.filter((node) => !node.data._reference).map((node) => node.id)
          const totalSelected = realNodeIds.length + edges.length
          onMultiSelectionChange(realNodeIds.length >= 2 ? realNodeIds : [], totalSelected)
          if (realNodeIds.length >= 2) {
            onSelectedNodeChange(null)
            onSelectedEdgeChange(null)
            return
          }
          if (realNodeIds.length === 1) {
            onSelectedNodeChange(realNodeIds[0])
          }
        }}
        onNodeClick={(event, node) => {
          setContextMenu(null)
          if (event.shiftKey) {
            suppressNativeSelectionRef.current = true
            window.setTimeout(() => {
              suppressNativeSelectionRef.current = false
            }, 0)
            if (node.data._reference) {
              return
            }
            const baseSelection =
              multiSelectedNodeIds.length > 0
                ? multiSelectedNodeIds
                : selectedVisibleNode
                  ? [selectedVisibleNode.id]
                  : []
            const nextSelection = baseSelection.includes(node.id)
              ? baseSelection.filter((nodeId) => nodeId !== node.id)
              : [...baseSelection, node.id]
            if (nextSelection.length >= 2) {
              onMultiSelectionChange(nextSelection, nextSelection.length)
            } else {
              onMultiSelectionChange([], nextSelection.length)
              onSelectedNodeChange(nextSelection[0] ?? null)
            }
            return
          }
          onSelectedNodeChange(node.id)
        }}
        onNodeDoubleClick={(_, node) => expandNode(node.id)}
        onEdgeClick={(_, edge) => onSelectedEdgeChange(edge.id)}
        onEdgeDoubleClick={(_, edge) => onSelectedEdgeChange(edge.id)}
        onPaneClick={() => {
          setContextMenu(null)
          onSelectedNodeChange(null)
          onSelectedEdgeChange(null)
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault()
          setContextMenu({ x: event.clientX, y: event.clientY, type: 'canvas' })
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          onSelectedNodeChange(node.id)
          setContextMenu({ x: event.clientX, y: event.clientY, type: 'node', nodeId: node.id })
        }}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault()
          onSelectedEdgeChange(edge.id)
          setContextMenu({ x: event.clientX, y: event.clientY, type: 'edge', edgeId: edge.id })
        }}
        connectionMode={ConnectionMode.Loose}
        defaultEdgeOptions={defaultEdgeOptions}
        nodesDraggable={!syncing}
        nodesConnectable={!syncing}
        elementsSelectable
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        multiSelectionKeyCode="Shift"
        snapToGrid
        snapGrid={[20, 20]}
        proOptions={{ hideAttribution: true }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[var(--architecture-canvas-bg)]" />
        <Background gap={20} variant={BackgroundVariant.Dots} size={1} color="var(--grid-color)" />
        <ViewportPortal>
          {groupBubbles.map((bubble) => (
            <div
              key={bubble.id}
              className="pointer-events-none absolute rounded-[28px] border border-emerald-400/35 bg-emerald-400/8 shadow-[0_0_0_1px_rgba(16,185,129,0.08)]"
              style={{
                left: bubble.x,
                top: bubble.y,
                width: bubble.width,
                height: bubble.height,
                zIndex: -10 - bubble.depth
              }}
              data-testid="architecture-group-bubble"
              data-group-id={bubble.id}
            >
              <div className="absolute left-4 top-2 rounded-full border border-emerald-400/30 bg-background/90 px-2 py-0.5 text-[10px] font-medium text-emerald-600 shadow-sm dark:text-emerald-300">
                {bubble.name} · {bubble.memberCount}
              </div>
            </div>
          ))}
        </ViewportPortal>
        <Panel position="top-left" className="!m-3">
          <div className="flex items-center gap-1 rounded-md border border-border bg-background/95 px-1 py-1 shadow-sm">
            <Button variant="ghost" size="xs" onClick={navigateToRoot}>
              Root
            </Button>
            {expandedPath.map((nodeId, index) => {
              const node = model.nodes.find((candidate) => candidate.id === nodeId)
              return (
                <div key={nodeId} className="flex items-center gap-1">
                  <ChevronRight className="size-3 text-muted-foreground" />
                  <Button variant="ghost" size="xs" onClick={() => navigateToBreadcrumb(index)}>
                    {node?.data.name ?? nodeId}
                  </Button>
                </div>
              )
            })}
          </div>
        </Panel>
        <Panel position="top-center" className="!m-3">
          <div className="flex items-center gap-1 rounded-md border border-border bg-background/95 px-1 py-1 shadow-sm">
            <Button
              variant="ghost"
              size="xs"
              onClick={addNodeAtLevel}
              disabled={syncing}
              data-testid="architecture-canvas-add-node"
            >
              <Plus className="size-3" />
              Add
            </Button>
            {selectedVisibleNode ? (
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive hover:text-destructive"
                onClick={deleteSelected}
                disabled={syncing}
              >
                <Trash2 className="size-3" />
                {selectedVisibleNode.data._reference ? 'Disconnect' : 'Delete'}
              </Button>
            ) : null}
            {selectedEdge ? (
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive hover:text-destructive"
                onClick={deleteSelected}
                disabled={syncing}
              >
                <Trash2 className="size-3" />
                Delete
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              onClick={autoLayout}
              disabled={syncing}
              data-testid="architecture-auto-layout"
            >
              <LayoutGrid className="size-3" />
              Layout
            </Button>
          </div>
        </Panel>
        <Panel position="bottom-right" className="!m-3">
          <div className="flex items-center gap-1 rounded-md border border-border bg-background/95 px-1 py-1 shadow-sm">
            <Button
              variant="ghost"
              size="icon-xs"
              title="Zoom in"
              onClick={() => void reactFlow.zoomIn()}
              data-testid="architecture-zoom-in"
            >
              <ZoomIn className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Zoom out"
              onClick={() => void reactFlow.zoomOut()}
              data-testid="architecture-zoom-out"
            >
              <Minus className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Fit view"
              onClick={() => void reactFlow.fitView({ padding: 0.2 })}
              data-testid="architecture-zoom-fit"
            >
              <Maximize className="size-3" />
            </Button>
          </div>
        </Panel>
        {contextMenu ? (
          <div
            className="fixed z-50 grid min-w-40 gap-1 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            data-testid="architecture-canvas-context-menu"
          >
            {contextMenu.type === 'canvas' ? (
              <>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-left hover:bg-accent"
                  onClick={() => addNodeAtCanvasPoint(contextMenu.x, contextMenu.y)}
                  data-testid="architecture-context-add-node"
                >
                  Add node here
                </button>
                {multiSelectedNodeIds.length >= 2 && onCreateGroupFromSelection ? (
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-left hover:bg-accent"
                    onClick={() => {
                      void onCreateGroupFromSelection('New group')
                      setContextMenu(null)
                    }}
                    data-testid="architecture-context-create-group"
                  >
                    Create group
                  </button>
                ) : null}
                {multiSelectedNodeIds.length >= 2 && onAddSelectionToGroup
                  ? (model.groups ?? []).map((group) => (
                      <button
                        key={group.id}
                        type="button"
                        className="rounded px-2 py-1 text-left hover:bg-accent"
                        onClick={() => {
                          void onAddSelectionToGroup(group.id)
                          setContextMenu(null)
                        }}
                        data-testid="architecture-context-add-to-group"
                      >
                        Add to {group.name}
                      </button>
                    ))
                  : null}
              </>
            ) : null}
            {contextMenu.type === 'node' && contextMenu.nodeId ? (
              <>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-left hover:bg-accent"
                  onClick={() => {
                    onSelectedNodeChange(contextMenu.nodeId ?? null)
                    setContextMenu(null)
                  }}
                >
                  Edit node
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-left text-destructive hover:bg-accent"
                  onClick={() => contextMenu.nodeId && deleteNodeFromMenu(contextMenu.nodeId)}
                  data-testid="architecture-context-delete-node"
                >
                  Delete node
                </button>
              </>
            ) : null}
            {contextMenu.type === 'edge' && contextMenu.edgeId ? (
              <>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-left hover:bg-accent"
                  onClick={() => {
                    onSelectedEdgeChange(contextMenu.edgeId ?? null)
                    setContextMenu(null)
                  }}
                  data-testid="architecture-context-edit-edge"
                >
                  Edit relationship
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-left text-destructive hover:bg-accent"
                  onClick={() => contextMenu.edgeId && deleteEdgeFromMenu(contextMenu.edgeId)}
                  data-testid="architecture-context-delete-edge"
                >
                  Delete relationship
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {showFillWithAi ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <button
              type="button"
              className="pointer-events-auto flex items-center gap-3 rounded border border-border bg-background px-4 py-3 text-left shadow hover:bg-accent"
              onClick={() => view.currentParentId && void onFillNodeWithAi?.(view.currentParentId)}
              data-testid="architecture-fill-ai"
            >
              <Bot className="size-4 text-violet-500" />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">Fill with AI</span>
                <span className="text-[11px] text-muted-foreground">
                  Scan the codebase and add {fillLabel}
                </span>
              </span>
            </button>
          </div>
        ) : null}
      </ReactFlow>
    </div>
  )
}

function toFlowNode(
  node: ArchitectureDiagramNode,
  options: { selected: boolean; data: Record<string, unknown> }
): ArchitectureFlowNode {
  return {
    id: node.id,
    type: node.type ?? 'architecture',
    position: node.position ?? { x: 0, y: 0 },
    initialWidth: INITIAL_NODE_WIDTH,
    initialHeight: INITIAL_NODE_HEIGHT,
    dragHandle: '.architecture-node-title',
    data: {
      ...node.data,
      _inspectorSelected: options.selected,
      ...options.data
    }
  }
}
