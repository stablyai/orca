import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ReactFlow,
  useReactFlow,
  type NodeChange
} from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentCanvasNode, type CanvasFlowNode } from './AgentCanvasNode'
import { AgentCanvasToolbar } from './AgentCanvasToolbar'
import { AgentCanvasEdge, type CanvasFlowEdge } from './AgentCanvasEdge'
import { useCanvasConnections } from './use-canvas-connections'
import { AgentCanvasConnectionPrompt } from './AgentCanvasConnectionPrompt'
import { buildCanvasFlowEdges } from './canvas-flow-edges'
import { applyCanvasFlowNodeChanges } from './canvas-flow-node-changes'
import { AgentCanvasViewportHud } from './AgentCanvasViewportHud'
import { handleCanvasKeyDown } from './canvas-keyboard-actions'
import { useAgentCanvasDocument } from './use-agent-canvas-document'
import { indexCanvasAgents, bindCanvasAgentNodes } from './canvas-agent-bindings'
import {
  canConnectCanvasNodes,
  canvasAgentKey,
  findCanvasNodePosition,
  removeCanvasNodes,
  type CanvasNode
} from './agent-canvas-document'
import '@xyflow/react/dist/style.css'
import './agent-canvas.css'
import { CanvasContextStatus, useCanvasAgentContext } from './use-canvas-agent-context'

const NODE_TYPES = { canvas: AgentCanvasNode }
const EDGE_TYPES = { context: AgentCanvasEdge }
const FIT_OPTIONS = { padding: 0.15, maxZoom: 1 }

export function AgentCanvasBoard({
  scope,
  cards,
  onReveal,
  launchOptions,
  onLaunchAgent
}: {
  scope: string
  cards: DashboardCard[]
  onReveal: (card: DashboardCard) => void
  launchOptions: TabAgentLaunchOption[]
  onLaunchAgent: (agent: TuiAgent) => Promise<string>
}) {
  const state = useAgentCanvasDocument(scope)
  const { document, update, checkpoint, readOnly } = state
  const contextStatus = useCanvasAgentContext(scope, document, cards, readOnly)
  const flow = useReactFlow<CanvasFlowNode>()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const {
    edgeId,
    setEdgeId,
    connectingSource,
    onConnectStart,
    onConnectEnd,
    onConnect,
    cancelConnection,
    connectNodes
  } = useCanvasConnections(document, update, readOnly)
  const [launching, setLaunching] = useState(false)
  const [dragging, setDragging] = useState(false)
  const cardsByKey = useMemo(() => indexCanvasAgents(cards), [cards])
  useEffect(() => {
    update((value) => bindCanvasAgentNodes(value, cardsByKey), false)
  }, [cardsByKey, document.nodes, update])
  const edit = useCallback(
    (id: string, patch: Partial<Pick<CanvasNode, 'title' | 'content' | 'browserTabId'>>) => {
      update(
        (value) => ({
          ...value,
          nodes: value.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node))
        }),
        false
      )
    },
    [update]
  )
  const removeNode = useCallback(
    (id: string) => {
      if (readOnly) {
        return
      }
      update((value) => removeCanvasNodes(value, new Set([id])))
      setSelectedId(null)
      setEdgeId(null)
    },
    [readOnly, update, setEdgeId]
  )
  const removeEdge = useCallback(
    (id: string) => {
      if (readOnly) {
        return
      }
      update((value) => ({ ...value, edges: value.edges.filter((edge) => edge.id !== id) }))
      setEdgeId(null)
    },
    [readOnly, update, setEdgeId]
  )
  const nodes = useMemo<CanvasFlowNode[]>(
    () =>
      document.nodes.map((node) => ({
        id: node.id,
        type: 'canvas',
        position: node.position,
        width: node.width,
        height: node.height,
        measured: { width: node.width, height: node.height },
        style: { width: node.width, height: node.height },
        selected: node.id === selectedId,
        dragHandle: '.canvas-node-header',
        data: {
          node,
          document,
          onConnect: connectNodes,
          connectingSource,
          interacting: dragging,
          onRemove: removeNode,
          card: cardsByKey.get(node.agentKey ?? node.agentTabId ?? ''),
          readOnly,
          onEdit: edit,
          onReveal,
          onEditStart: checkpoint
        }
      })),
    [
      cardsByKey,
      checkpoint,
      document,
      edit,
      onReveal,
      readOnly,
      selectedId,
      connectNodes,
      connectingSource,
      dragging,
      removeNode
    ]
  )
  const edges = useMemo(
    () =>
      buildCanvasFlowEdges(document, cardsByKey, edgeId, readOnly, setEdgeId, removeEdge, scope),
    [document, edgeId, cardsByKey, readOnly, setEdgeId, removeEdge, scope]
  )
  const addNode = (
    kind: CanvasNode['kind'],
    card?: DashboardCard,
    launched?: { agent: TuiAgent; tabId: string }
  ): void => {
    if (document.nodes.length >= 500) {
      return
    }
    const id = crypto.randomUUID()
    const viewport = flow.getViewport()
    const position = { x: (80 - viewport.x) / viewport.zoom, y: (80 - viewport.y) / viewport.zoom }
    const node: CanvasNode = {
      id,
      kind,
      position: findCanvasNodePosition(document.nodes, position, {
        width: kind === 'browser' ? 720 : kind === 'agent' ? 480 : 320,
        height: kind === 'browser' ? 520 : kind === 'agent' ? 360 : 240
      }),
      width: kind === 'browser' ? 720 : kind === 'agent' ? 480 : 320,
      height: kind === 'browser' ? 520 : kind === 'agent' ? 360 : 240,
      title:
        launched?.agent ??
        card?.conversationName ??
        card?.agentType ??
        (kind === 'note'
          ? translate('agentCanvas.newNote', 'Untitled note')
          : translate('agentCanvas.newBrowser', 'Browser page')),
      content: '',
      ...(card ? { agentKey: canvasAgentKey(card) } : {}),
      ...(launched ? { agentTabId: launched.tabId } : {})
    }
    update((value) => ({ ...value, nodes: [...value.nodes, node] }))
    setSelectedId(id)
    setEdgeId(null)
  }
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      for (const change of changes) {
        if (change.type === 'select' && change.selected) {
          setSelectedId(change.id)
          setEdgeId(null)
        }
      }
      update((value) => applyCanvasFlowNodeChanges(value, changes), false)
    },
    [update, setEdgeId]
  )
  const selected = document.nodes.find((node) => node.id === selectedId)
  const placed = new Set(document.nodes.map((node) => node.agentKey ?? node.agentTabId))
  return (
    <CanvasContextStatus.Provider value={contextStatus}>
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        data-agent-canvas-surface
        onKeyDownCapture={(event) => {
          if (
            connectingSource &&
            event.key === 'Escape' &&
            !(event.target as HTMLElement).closest('[role="dialog"]')
          ) {
            event.stopPropagation()
            cancelConnection()
          }
        }}
        onKeyDown={(event) =>
          handleCanvasKeyDown(event, {
            readOnly,
            selectedId,
            edgeId,
            removeNode,
            removeEdge,
            clearSelection: () => {
              setSelectedId(null)
              setEdgeId(null)
            }
          })
        }
      >
        <AgentCanvasToolbar
          collaborationPaused={document.collaborationPaused}
          onToggleCollaboration={
            document.edges.some(
              (edge) => document.nodes.find((node) => node.id === edge.source)?.kind === 'agent'
            )
              ? () =>
                  update((value) => ({ ...value, collaborationPaused: !value.collaborationPaused }))
              : undefined
          }
          agents={cards.filter(
            (card) => !placed.has(canvasAgentKey(card)) && !placed.has(card.tabId)
          )}
          launchOptions={launchOptions}
          launching={launching}
          onLaunchAgent={(agent) => {
            if (launching || document.nodes.length >= 500) {
              return
            }
            setLaunching(true)
            void onLaunchAgent(agent)
              .then((tabId) => addNode('agent', undefined, { agent, tabId }))
              .catch((error) => toast.error(error.message))
              .finally(() => setLaunching(false))
          }}
          selected={selected}
          readOnly={readOnly}
          canUndo={state.canUndo}
          onAddAgent={(card) => addNode('agent', card)}
          onAddNode={addNode}
          onRemove={() => {
            if (selected) {
              removeNode(selected.id)
            }
          }}
          onUndo={state.undo}
          onFit={() => void flow.fitView(FIT_OPTIONS)}
          onZoom={(direction) => void (direction === 'in' ? flow.zoomIn() : flow.zoomOut())}
        />
        {state.error && (
          <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
            {state.error}
            {!readOnly && (
              <Button variant="outline" size="xs" onClick={state.save}>
                {translate('agentCanvas.retrySave', 'Retry save')}
              </Button>
            )}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1" data-agent-canvas>
            {connectingSource && (
              <AgentCanvasConnectionPrompt
                source={connectingSource}
                document={document}
                onCancel={cancelConnection}
              />
            )}
            <ReactFlow<CanvasFlowNode, CanvasFlowEdge>
              className="agent-canvas"
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onConnect={onConnect}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              connectionLineType={ConnectionLineType.SmoothStep}
              connectionLineStyle={{ stroke: 'var(--foreground)', strokeWidth: 2 }}
              isValidConnection={(connection) =>
                canConnectCanvasNodes(document, connection.source, connection.target)
              }
              onNodeDragStart={() => {
                checkpoint()
                setDragging(true)
              }}
              onNodeDragStop={() => setDragging(false)}
              onNodeClick={(_, node) => {
                setSelectedId(node.id)
                setEdgeId(null)
              }}
              onEdgeClick={(_, clicked) => {
                setEdgeId(clicked.id)
                setSelectedId(null)
              }}
              onPaneClick={() => {
                setSelectedId(null)
                setEdgeId(null)
              }}
              defaultViewport={document.viewport}
              onMoveEnd={(_, viewport) => update((value) => ({ ...value, viewport }), false)}
              minZoom={0.2}
              maxZoom={2}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              connectOnClick
              connectionRadius={28}
              deleteKeyCode={null}
              multiSelectionKeyCode={null}
              zoomOnDoubleClick={false}
              onlyRenderVisibleElements={false}
            >
              <Background
                id="canvas-grid"
                variant={BackgroundVariant.Lines}
                color="var(--canvas-grid-line)"
                gap={160}
              />
              <Background id="canvas-dots" color="var(--canvas-grid-dot)" gap={20} size={1.2} />
              <AgentCanvasViewportHud />
            </ReactFlow>
            {nodes.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
                <div className="max-w-sm text-center">
                  <p className="text-sm font-medium">
                    {translate('agentCanvas.emptyTitle', 'Bring your agents together')}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {translate(
                      'agentCanvas.emptyDescription',
                      'Arrange agents, reference notes, and pages. Drag the background to explore your workspace.'
                    )}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>{translate('agentCanvas.localLayout', 'Canvas on this device')}</span>
          <span>
            {translate(
              'agentCanvas.canvasHint',
              'Drag a point to connect · × to remove · Undo to restore'
            )}
          </span>
        </div>
      </div>
    </CanvasContextStatus.Provider>
  )
}
