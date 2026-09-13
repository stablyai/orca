// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentCanvasBrowser, CanvasBrowserContext } from './AgentCanvasBrowser'
import type { CanvasNode } from './agent-canvas-document'

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, place: vi.fn() }))
vi.mock('@xyflow/react', () => ({ useViewport: () => ({ x: 0, y: 0, zoom: 1 }) }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select(mocks.state)
}))
vi.mock('../browser-pane/host-guest/embedded-browser-placement', () => ({
  setEmbeddedBrowserPlacement: mocks.place,
  measureEmbeddedBrowserPlacement: vi.fn(() => ({}))
}))

const node: CanvasNode = {
  id: 'card',
  kind: 'browser',
  title: 'Browser page',
  content: '',
  position: { x: 0, y: 0 },
  width: 720,
  height: 520
}
const context = { worktreeId: 'worktree', executionHostId: 'local', create: vi.fn() }

beforeEach(() => {
  mocks.state = { unifiedTabsByWorktree: {}, browserTabsByWorktree: {} }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function mount(create = vi.fn().mockResolvedValue('browser'), overrides: Partial<CanvasNode> = {}) {
  const edit = vi.fn()
  context.create.mockImplementation(create)
  const view = render(
    <CanvasBrowserContext.Provider value={context}>
      <div data-agent-canvas>
        <div className="react-flow__node">
          <AgentCanvasBrowser
            node={{ ...node, ...overrides }}
            readOnly={false}
            connecting={false}
            onEdit={edit}
          />
        </div>
      </div>
    </CanvasBrowserContext.Provider>
  )
  return { ...view, edit, create }
}

it('normalizes a localhost URL and binds exactly the workspace returned by creation', async () => {
  const view = mount()
  fireEvent.change(view.getByRole('textbox', { name: 'Browser URL' }), {
    target: { value: 'localhost:3000' }
  })
  fireEvent.click(view.getByRole('button', { name: 'Open page' }))
  await waitFor(() =>
    expect(view.edit).toHaveBeenCalledWith('card', {
      browserTabId: 'browser',
      content: 'http://localhost:3000/'
    })
  )
  expect(view.create).toHaveBeenCalledExactlyOnceWith('http://localhost:3000/')
})

it('shows opening errors without attaching another page or discarding the address', async () => {
  const view = mount(vi.fn().mockRejectedValue(new Error('Workspace disconnected')))
  fireEvent.change(view.getByRole('textbox', { name: 'Browser URL' }), {
    target: { value: 'https://example.com' }
  })
  fireEvent.click(view.getByRole('button', { name: 'Open page' }))
  await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Workspace disconnected'))
  expect(view.edit.mock.calls.some(([, patch]) => patch.browserTabId)).toBe(false)
  expect((view.getByRole('textbox', { name: 'Browser URL' }) as HTMLInputElement).value).toBe(
    'https://example.com'
  )
})

it('does not embed a page owned by another execution host', () => {
  mocks.state = {
    unifiedTabsByWorktree: {
      worktree: [{ entityId: 'browser', contentType: 'browser', executionHostId: 'ssh:other' }]
    },
    browserTabsByWorktree: {
      worktree: [{ id: 'browser', url: 'https://other.example', title: 'Other host' }]
    }
  }
  const view = mount(undefined, { browserTabId: 'browser' })
  expect(view.getByRole('textbox', { name: 'Browser URL' })).toBeDefined()
  expect(mocks.place).not.toHaveBeenCalled()
})
