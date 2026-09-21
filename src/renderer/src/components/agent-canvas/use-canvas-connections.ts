import { useCallback, useRef, useState } from 'react'
import { canConnectCanvasNodes, type CanvasDocument } from './agent-canvas-document'
import type { OnConnect, OnConnectEnd, OnConnectStart } from '@xyflow/react'

export function useCanvasConnections(
  document: CanvasDocument,
  update: (change: (value: CanvasDocument) => CanvasDocument) => void,
  readOnly: boolean
) {
  const [edgeId, setEdgeId] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const cancelled = useRef(false)
  const connectingSource = document.nodes.find((node) => node.id === sourceId) ?? null
  const beginConnection = useCallback(
    (id: string) => {
      if (readOnly) {
        return
      }
      setSourceId(id)
      cancelled.current = false
      setEdgeId(null)
    },
    [readOnly]
  )
  const cancelConnection = useCallback(() => {
    cancelled.current = true
    setSourceId(null)
  }, [])
  const connectNodes = useCallback(
    (source: string, target: string) => {
      if (readOnly) {
        return
      }
      const existing = document.edges.find(
        (edge) =>
          (edge.source === source && edge.target === target) ||
          (edge.source === target &&
            edge.target === source &&
            document.nodes.find((node) => node.id === source)?.kind === 'agent')
      )
      if (existing) {
        setEdgeId(existing.id)
        setSourceId(null)
        return
      }
      if (!canConnectCanvasNodes(document, source, target) || document.edges.length >= 2000) {
        return
      }
      const id = crypto.randomUUID()
      update((value) =>
        canConnectCanvasNodes(value, source, target) && value.edges.length < 2000
          ? { ...value, edges: [...value.edges, { id, source, target }] }
          : value
      )
      setSourceId(null)
      setEdgeId(null)
    },
    [document, readOnly, update]
  )
  const onConnectStart: OnConnectStart = (_, { nodeId, handleType }) => {
    cancelled.current = false
    if (nodeId && handleType === 'source') {
      beginConnection(nodeId)
    }
  }
  const onConnectEnd: OnConnectEnd = (event, connection) => {
    setSourceId(null)
    if (
      cancelled.current ||
      connection.isValid ||
      connection.fromHandle?.type !== 'source' ||
      !connection.fromNode
    ) {
      return
    }
    const point = 'changedTouches' in event ? event.changedTouches[0] : event
    const element = point ? window.document.elementFromPoint(point.clientX, point.clientY) : null
    const targetId = element?.closest('.react-flow__node')?.getAttribute('data-id')
    if (targetId) {
      connectNodes(connection.fromNode.id, targetId)
    }
  }
  const onConnect: OnConnect = ({ source, target }) => {
    if (!cancelled.current) {
      connectNodes(source, target)
    }
  }
  return {
    edgeId,
    setEdgeId,
    connectingSource,
    cancelConnection,
    connectNodes,
    onConnectStart,
    onConnectEnd,
    onConnect
  }
}
