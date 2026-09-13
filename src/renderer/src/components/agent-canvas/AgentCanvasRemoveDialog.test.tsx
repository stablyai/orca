// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { CanvasNode } from './agent-canvas-document'
import { AgentCanvasRemoveDialog } from './AgentCanvasRemoveDialog'
import { AgentCanvasContextStatus } from './AgentCanvasContextStatus'
import { CanvasContextStatus } from './use-canvas-agent-context'

afterEach(cleanup)
const changedSessionContext = {
  error: null,
  nodes: { card: { state: 'session-changed' as const, provider: 'codex' as const } }
}
const node: CanvasNode = {
  id: 'card',
  kind: 'agent',
  title: 'Codex',
  content: '',
  position: { x: 0, y: 0 },
  width: 480,
  height: 360
}

it.each(['terminal', 'browser'] as const)(
  'distinguishes detach from closing the %s tab',
  (contentType) => {
    const onDetach = vi.fn(),
      onCloseTab = vi.fn(),
      onCancel = vi.fn()
    const view = render(
      <AgentCanvasRemoveDialog
        node={node}
        tab={{ contentType } as Tab}
        onDetach={onDetach}
        onCloseTab={onCloseTab}
        onCancel={onCancel}
      />
    )
    expect(view.getByText(/The tab stays open and running/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Remove from canvas' }))
    expect(onDetach).toHaveBeenCalledOnce()
    expect(onCloseTab).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Remove and close tab' }))
    expect(onCloseTab).toHaveBeenCalledOnce()
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  }
)

it('does not offer a tab close for notes or missing resources, and respects pins', () => {
  const props = { node, onDetach: vi.fn(), onCloseTab: vi.fn(), onCancel: vi.fn() }
  const view = render(<AgentCanvasRemoveDialog {...props} />)
  expect(view.queryByRole('button', { name: 'Remove and close tab' })).toBeNull()
  view.rerender(
    <AgentCanvasRemoveDialog {...props} tab={{ contentType: 'terminal', isPinned: true } as Tab} />
  )
  expect(view.getByRole('button', { name: 'Remove and close tab' }).hasAttribute('disabled')).toBe(
    true
  )
  fireEvent.click(view.getByRole('button', { name: 'Remove and close tab' }))
  expect(props.onCloseTab).not.toHaveBeenCalled()
})

it('requires confirmation to adopt a changed agent session', () => {
  const adopt = vi.fn()
  const view = render(
    <CanvasContextStatus.Provider value={changedSessionContext}>
      <AgentCanvasContextStatus nodeId="card" onAdoptSession={adopt} />
    </CanvasContextStatus.Provider>
  )
  fireEvent.click(view.getByRole('button', { name: 'Use current session' }))
  expect(adopt).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
  expect(adopt).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Use current session' }))
  fireEvent.click(view.getByRole('dialog').querySelector('button[data-slot="button"]:last-child')!)
  expect(adopt).toHaveBeenCalledWith('card')
})
