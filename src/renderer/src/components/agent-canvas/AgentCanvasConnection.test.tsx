// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentCanvasConnection } from './AgentCanvasConnection'
import { sendCanvasContext } from './agent-canvas-delivery'
import type { CanvasNode } from './agent-canvas-document'

vi.mock('./agent-canvas-delivery', () => ({ sendCanvasContext: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('identifies an agent-created browser without asking to send context again', () => {
  const node: CanvasNode = {
    id: 'browser',
    kind: 'browser',
    browserTabId: 'native-browser',
    title: 'Preview',
    content: 'http://localhost:3000',
    width: 720,
    height: 520,
    position: { x: 0, y: 0 }
  }
  const view = render(
    <TooltipProvider>
      <AgentCanvasConnection
        source={node}
        target={{ ...node, id: 'agent', kind: 'agent' }}
        browserControl
        readOnly={false}
        onClose={vi.fn()}
        onRemove={vi.fn()}
      />
    </TooltipProvider>
  )
  expect(view.getByText(/Created by this agent/)).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Send context' })).toBeNull()
  expect(sendCanvasContext).not.toHaveBeenCalled()
})

it('inspects the live note without a send action, draft, or terminal input', () => {
  const source: CanvasNode = {
    id: 'note',
    kind: 'note',
    title: 'Requirements',
    content: 'Keep the API compatible.',
    position: { x: 0, y: 0 },
    width: 320,
    height: 240
  }
  const props = {
    source,
    target: { ...source, id: 'agent', kind: 'agent' as const, title: 'Codex' },
    readOnly: false,
    onClose: vi.fn(),
    onRemove: vi.fn()
  }
  const view = render(
    <TooltipProvider>
      <AgentCanvasConnection {...props} />
    </TooltipProvider>
  )
  expect(view.getByLabelText('Linked note').textContent).toBe(source.content)
  expect(view.queryByRole('textbox')).toBeNull()
  expect(view.queryByRole('button', { name: 'Send context' })).toBeNull()
  expect(view.getByRole('status').textContent).toContain('Waiting for the agent hook')
  view.rerender(
    <TooltipProvider>
      <AgentCanvasConnection
        {...props}
        source={{ ...source, content: 'Use the current schema.' }}
      />
    </TooltipProvider>
  )
  expect(view.getByLabelText('Linked note').textContent).toBe('Use the current schema.')
  fireEvent.click(view.getByRole('button', { name: 'Disconnect' }))
  expect(props.onRemove).toHaveBeenCalledOnce()
  expect(sendCanvasContext).not.toHaveBeenCalled()
})
