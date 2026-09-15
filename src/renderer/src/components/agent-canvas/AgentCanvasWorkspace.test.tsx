// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import AgentCanvasWorkspace from './AgentCanvasWorkspace'
import { CANVAS_STORAGE_PREFIX, useAgentCanvasDocument } from './use-agent-canvas-document'

vi.mock('@/store', () => ({ useAppStore: (select: (state: unknown) => unknown) => select({}) }))
vi.mock('@/hooks/useDetectedAgents', () => ({ useDetectedAgents: () => ({ detectedIds: [] }) }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({ useAgentDetectionTargetForWorktree: vi.fn() }))
vi.mock('../dashboard/useLiveDashboardSnapshot', () => ({ useLiveDashboardSnapshot: () => ({}) }))
vi.mock('../dashboard/reveal-dashboard-agent', () => ({ revealDashboardAgent: vi.fn() }))
vi.mock('./use-canvas-workspace-cards', () => ({ useCanvasWorkspaceCards: () => [] }))
vi.mock('./launch-canvas-agent', () => ({ launchCanvasAgent: vi.fn() }))
vi.mock('@/lib/workspace-browser-tab-open', () => ({ openWorkspaceBrowserTab: vi.fn() }))
vi.mock('./AgentCanvasBoard', () => ({
  AgentCanvasBoard: function Board({ scope }: { scope: string }) {
    const { document, update, canUndo } = useAgentCanvasDocument(scope)
    return (
      <>
        <input
          aria-label="Canvas position"
          value={document.viewport.x}
          onChange={(event) => {
            const x = Number(event.target.value)
            update((value) => ({ ...value, viewport: { ...value.viewport, x } }))
          }}
        />
        <button disabled={!canUndo}>Undo</button>
      </>
    )
  }
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it.each(['worktreeId', 'executionHostId'] as const)(
  'isolates persisted documents and undo when %s changes without changing the tab ID',
  (field) => {
    const tab = { id: 'canvas', worktreeId: 'folder:old', executionHostId: 'local' } as Tab
    const scope = (value: Tab) =>
      JSON.stringify(['workspace-tab', value.executionHostId, value.worktreeId, value.id])
    const view = render(<AgentCanvasWorkspace tab={tab} />)
    fireEvent.change(view.getByRole('textbox', { name: 'Canvas position' }), {
      target: { value: '123' }
    })
    const next = {
      ...tab,
      [field]: field === 'worktreeId' ? 'folder:new' : 'runtime:remote'
    } as Tab
    view.rerender(<AgentCanvasWorkspace tab={next} />)
    expect((view.getByRole('textbox', { name: 'Canvas position' }) as HTMLInputElement).value).toBe(
      '40'
    )
    expect((view.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(view.getByRole('textbox', { name: 'Canvas position' }), {
      target: { value: '456' }
    })
    view.unmount()
    expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_PREFIX + scope(tab))!).viewport.x).toBe(
      123
    )
    expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_PREFIX + scope(next))!).viewport.x).toBe(
      456
    )
  }
)
