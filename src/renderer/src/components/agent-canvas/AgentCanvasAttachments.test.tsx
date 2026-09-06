// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCanvasAttachments } from './AgentCanvasAttachments'
import { emptyCanvasDocument, type CanvasNode } from './agent-canvas-document'

afterEach(cleanup)

it('closes the attachment list before opening a note for inspection', () => {
  const onConnect = vi.fn()
  const note: CanvasNode = {
    id: 'note',
    kind: 'note',
    title: 'Requirements',
    content: 'Context',
    position: { x: 0, y: 0 },
    width: 320,
    height: 240
  }
  const view = render(
    <AgentCanvasAttachments
      nodeId="agent"
      document={{
        ...emptyCanvasDocument(),
        nodes: [note],
        edges: [{ id: 'edge', source: 'note', target: 'agent' }]
      }}
      onConnect={onConnect}
    />
  )
  fireEvent.click(view.getByRole('button', { name: 'Attached notes' }))
  expect(view.getByRole('dialog')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Requirements' }))
  expect(onConnect).toHaveBeenCalledWith('note', 'agent')
  expect(view.queryByRole('dialog')).toBeNull()
})
