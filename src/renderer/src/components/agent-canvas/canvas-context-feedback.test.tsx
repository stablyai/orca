// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCanvasContextStatus } from './AgentCanvasContextStatus'
import { AgentCanvasConversation } from './AgentCanvasConversation'
import { CanvasContextStatus } from './use-canvas-agent-context'
import type { CanvasNode } from './agent-canvas-document'
import type { CanvasContextView } from './canvas-context-sync'

vi.mock('./use-canvas-message-history', () => ({
  useCanvasMessageHistory: () => ({ messages: [], error: null, loading: false })
}))
afterEach(cleanup)

const agent = (id: string): CanvasNode => ({
  id,
  kind: 'agent',
  title: id,
  content: '',
  position: { x: 0, y: 0 },
  width: 480,
  height: 360
})

const partialContext: CanvasContextView = {
  error: 'Some agent terminals are unverifiable; their context is pending.',
  nodes: {
    a: { state: 'returned', provider: 'codex' },
    b: { state: 'ready', provider: 'claude' },
    c: { state: 'unverifiable', provider: 'cursor' }
  }
}
const unavailableContext: CanvasContextView = { nodes: {}, error: 'Execution host unavailable' }

it('keeps healthy card and connection status when another terminal is unverifiable', () => {
  const view = render(
    <CanvasContextStatus.Provider value={partialContext}>
      <AgentCanvasContextStatus nodeId="a" />
      <AgentCanvasConversation
        source={agent('a')}
        target={agent('b')}
        readOnly={false}
        onClose={vi.fn()}
        onRemove={vi.fn()}
      />
    </CanvasContextStatus.Provider>
  )
  expect(view.getByText('Context returned to agent hook')).toBeTruthy()
  expect(view.getByText('Connected · agents can exchange messages')).toBeTruthy()
  expect(view.queryByText(/Some agent terminals/)).toBeNull()
})

it('still exposes a host-wide failure when node state cannot be verified', () => {
  const view = render(
    <CanvasContextStatus.Provider value={unavailableContext}>
      <AgentCanvasContextStatus nodeId="a" />
    </CanvasContextStatus.Provider>
  )
  expect(view.getByRole('status').textContent).toBe('Execution host unavailable')
})
