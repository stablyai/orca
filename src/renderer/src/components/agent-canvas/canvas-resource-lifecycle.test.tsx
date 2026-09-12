// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import {
  emptyCanvasDocument,
  removeCanvasNodes,
  type CanvasDocument
} from './agent-canvas-document'
import { CANVAS_STORAGE_PREFIX, readCanvasDocument } from './canvas-document-access'
import { useAgentCanvasDocument } from './use-agent-canvas-document'
import { canvasResourceTab } from './canvas-resource-tabs'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  const rendererWindow = window
  const api = createTabsSliceMockApi()
  globalThis.window = rendererWindow
  Object.assign(window, { api })
  localStorage.clear()
})
afterEach(cleanup)

function fixture(type: 'browser' | 'terminal' = 'browser') {
  const store = createTestStore()
  const workspace = 'folder:design'
  store.setState({ activeWorktreeId: workspace, activeWorkspaceExecutionHostId: 'local' })
  const resource =
    type === 'terminal'
      ? store.getState().createTab(workspace)
      : store.getState().createBrowserTab(workspace, 'https://example.com')
  const tab = store
    .getState()
    .unifiedTabsByWorktree[workspace].find((item) => item.entityId === resource.id)!
  const canvas = store.getState().createUnifiedTab(workspace, 'canvas', { label: 'Canvas' })
  const scope = JSON.stringify(['workspace-tab', canvas.executionHostId, workspace, canvas.id])
  const document: CanvasDocument = {
    ...emptyCanvasDocument(),
    nodes: [
      {
        id: 'resource',
        kind: type === 'terminal' ? 'agent' : 'browser',
        title: 'Tool',
        content: '',
        position: { x: 0, y: 0 },
        width: 480,
        height: 360,
        ...(type === 'terminal' ? { agentTabId: resource.id } : { browserTabId: resource.id })
      },
      {
        id: 'agent',
        kind: 'agent',
        agentTabId: 'other-terminal',
        title: 'Other',
        content: '',
        position: { x: 500, y: 0 },
        width: 480,
        height: 360
      }
    ],
    edges: [{ id: 'link', source: 'resource', target: 'agent' }]
  }
  localStorage.setItem(CANVAS_STORAGE_PREFIX + scope, JSON.stringify(document))
  return { store, tab, canvas, scope, document }
}

it.each(['browser', 'terminal'] as const)(
  'closing a %s tab cleans hidden canvas cards and edges through store actions',
  (type) => {
    const { store, tab, scope } = fixture(type)
    store.getState().closeUnifiedTab(tab.id)
    expect(
      store.getState().unifiedTabsByWorktree[tab.worktreeId].some((item) => item.id === tab.id)
    ).toBe(false)
    const saved = readCanvasDocument(CANVAS_STORAGE_PREFIX + scope)
    expect(saved.error).toBeNull()
    expect(saved.document.nodes.map((node) => node.id)).toEqual(['agent'])
    expect(saved.document.edges).toEqual([])
  }
)

it.each([false, true])(
  'prunes mounted undo history even if the card was already detached (%s)',
  (detachFirst) => {
    const { store, tab, scope } = fixture()
    const view = renderHook(() => useAgentCanvasDocument(scope))
    act(() =>
      view.result.current.update((value) => ({ ...value, viewport: { x: 200, y: 0, zoom: 1 } }))
    )
    if (detachFirst) {
      act(() =>
        view.result.current.update((value) => removeCanvasNodes(value, new Set(['resource'])))
      )
      expect(store.getState().unifiedTabsByWorktree[tab.worktreeId]).toContainEqual(tab)
    }
    act(() => store.getState().closeUnifiedTab(tab.id))
    for (let index = 0; index < 3; index++) {
      act(() => view.result.current.undo())
      expect(view.result.current.document.nodes.map((node) => node.id)).toEqual(['agent'])
      expect(view.result.current.document.edges).toEqual([])
    }
  }
)

it('matches exact host, workspace and terminal pane without closing a sibling tab', () => {
  const { tab, canvas, document } = fixture('terminal')
  const node = {
    ...document.nodes[0],
    agentKey: JSON.stringify([
      'local',
      'repo',
      tab.worktreeId,
      makePaneKey(tab.entityId, '11111111-1111-4111-8111-111111111111')
    ])
  }
  const remote = { ...tab, executionHostId: 'runtime:other' } as Tab
  expect(canvasResourceTab(node, canvas, [remote, tab], 'local')).toEqual(tab)
  expect(canvasResourceTab(node, canvas, [remote])).toBeUndefined()
  expect(
    canvasResourceTab({ ...node, agentKey: 'invalid', agentTabId: tab.entityId }, canvas, [tab])
  ).toBeUndefined()
})

it('does not undo a user-confirmed session adoption into the previous binding', () => {
  const { scope } = fixture('terminal')
  const view = renderHook(() => useAgentCanvasDocument(scope))
  act(() => view.result.current.checkpoint())
  act(() => view.result.current.adoptSession('resource'))
  const adopted = view.result.current.document.nodes[0].id
  expect(adopted).not.toBe('resource')
  act(() => view.result.current.undo())
  expect(view.result.current.document.nodes[0].id).toBe(adopted)
})

it('does not prune a canvas on another host with colliding resource ids', () => {
  const { store, tab, canvas, document } = fixture()
  const remote = { ...canvas, id: 'remote-canvas', executionHostId: 'runtime:other' } as Tab
  const scope = JSON.stringify([
    'workspace-tab',
    remote.executionHostId,
    remote.worktreeId,
    remote.id
  ])
  store.setState((state) => ({
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [tab.worktreeId]: [...state.unifiedTabsByWorktree[tab.worktreeId], remote]
    }
  }))
  localStorage.setItem(CANVAS_STORAGE_PREFIX + scope, JSON.stringify(document))
  store.getState().closeUnifiedTab(tab.id)
  expect(readCanvasDocument(CANVAS_STORAGE_PREFIX + scope).document).toEqual(document)
})
