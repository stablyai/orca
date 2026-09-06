// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyCanvasDocument, type CanvasDocument, type CanvasNode } from './agent-canvas-document'
import { useCanvasConnections } from './use-canvas-connections'

afterEach(cleanup)

function setup(readOnly = false) {
  return renderHook(() => {
    const [document, update] = useState<CanvasDocument>(() => ({
      ...emptyCanvasDocument(),
      nodes: ['note', 'agent'].map((kind) => ({
        id: kind,
        kind: kind as CanvasNode['kind'],
        title: kind,
        content: '',
        position: { x: 0, y: 0 },
        width: 320,
        height: 240
      }))
    }))
    return { ...useCanvasConnections(document, update, readOnly), document }
  })
}

const connection = { source: 'note', target: 'agent', sourceHandle: null, targetHandle: null }
const start = { nodeId: 'note', handleId: null, handleType: 'source' as const }

describe('canvas connection gestures', () => {
  it('links without opening a dialog and opens details only on explicit inspection', () => {
    const { result } = setup()
    act(() => result.current.onConnectStart(new MouseEvent('mousedown'), start))
    expect(result.current.connectingSource?.id).toBe('note')
    act(() => result.current.onConnect(connection))
    expect(result.current.document.edges).toHaveLength(1)
    const edgeId = result.current.document.edges[0].id
    expect(result.current.edgeId).toBeNull()
    expect(result.current.connectingSource).toBeNull()
    act(() => result.current.connectNodes('note', 'agent'))
    expect(result.current.document.edges).toHaveLength(1)
    expect(result.current.edgeId).toBe(edgeId)
  })

  it('does not create a line after cancellation, but allows the next gesture', () => {
    const { result } = setup()
    act(() => result.current.onConnectStart(new MouseEvent('mousedown'), start))
    act(() => result.current.cancelConnection())
    act(() => result.current.onConnect(connection))
    expect(result.current.document.edges).toHaveLength(0)
    act(() => result.current.onConnectStart(new MouseEvent('mousedown'), start))
    act(() => result.current.onConnect(connection))
    expect(result.current.document.edges).toHaveLength(1)
  })

  it('rejects self-links, note targets, and read-only edits', () => {
    const { result } = setup()
    act(() => result.current.connectNodes('note', 'note'))
    act(() => result.current.connectNodes('agent', 'note'))
    expect(result.current.document.edges).toHaveLength(0)
    const locked = setup(true)
    act(() => locked.result.current.onConnect(connection))
    expect(locked.result.current.document.edges).toHaveLength(0)
  })
})
