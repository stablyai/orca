// @vitest-environment happy-dom
import { useEffect } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NodeProps } from '@xyflow/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentCanvasNode, type CanvasFlowNode } from './AgentCanvasNode'
import { emptyCanvasDocument } from './agent-canvas-document'
import type { CanvasAgentCard } from './use-canvas-workspace-cards'

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }))
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Left: 'left', Right: 'right' }
}))
vi.mock('./AgentCanvasConnectMenu', () => ({
  AgentCanvasConnectMenu: () => <button>Connect</button>
}))
vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId }: { ptyId: string }) => {
    useEffect(() => {
      lifecycle.mount(ptyId)
      return () => lifecycle.unmount(ptyId)
    }, [ptyId])
    return <div data-testid="live-terminal">{ptyId}</div>
  }
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('keeps the same live preview mounted when selection changes and exposes removal without selection', () => {
  const remove = vi.fn()
  const props: NodeProps<CanvasFlowNode> = {
    id: 'node',
    type: 'canvas',
    selected: true,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    data: {
      node: {
        id: 'node',
        kind: 'agent',
        title: 'Codex',
        content: '',
        position: { x: 0, y: 0 },
        width: 480,
        height: 360
      },
      card: {
        ptyId: 'live-pty',
        tabId: 'terminal',
        worktreeName: 'main',
        canvasStatusUnknown: true
      } as CanvasAgentCard,
      document: emptyCanvasDocument(),
      readOnly: false,
      onRemove: remove,
      onConnect: vi.fn(),
      connectingSource: null,
      onEdit: vi.fn(),
      onEditStart: vi.fn(),
      onReveal: vi.fn()
    }
  }
  const view = render(
    <TooltipProvider>
      <AgentCanvasNode {...props} />
    </TooltipProvider>
  )
  const preview = view.getByTestId('live-terminal')
  view.rerender(
    <TooltipProvider>
      <AgentCanvasNode {...props} selected={false} />
    </TooltipProvider>
  )
  expect(view.getByTestId('live-terminal')).toBe(preview)
  for (const agentType of ['codex', 'claude', 'cursor'] as const) {
    view.rerender(
      <TooltipProvider>
        <AgentCanvasNode
          {...props}
          selected={false}
          data={{ ...props.data, card: { ...props.data.card!, agentType } }}
        />
      </TooltipProvider>
    )
    expect(view.getByLabelText(agentType).getAttribute('data-canvas-agent-icon')).toBe(agentType)
    expect(view.getByTestId('live-terminal')).toBe(preview)
  }
  expect(lifecycle.mount).toHaveBeenCalledTimes(1)
  expect(lifecycle.unmount).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Remove card' }))
  expect(remove).toHaveBeenCalledWith('node')
})
