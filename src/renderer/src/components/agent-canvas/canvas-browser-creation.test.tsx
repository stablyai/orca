// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { addCreatedBrowserToCanvas, resolveBrowserCanvasTarget } from './canvas-browser-creation'
import { CANVAS_STORAGE_PREFIX, useAgentCanvasDocument } from './use-agent-canvas-document'
import { emptyCanvasDocument, type CanvasDocument } from './agent-canvas-document'

const leaf = '11111111-1111-4111-8111-111111111111'
const pane = `terminal:${leaf}`
const scope = JSON.stringify(['workspace-tab', 'local', 'folder', 'canvas'])
const state = {
  unifiedTabsByWorktree: {
    folder: [
      { id: 'terminal', entityId: 'terminal', contentType: 'terminal', executionHostId: 'local' },
      { id: 'canvas', contentType: 'canvas', executionHostId: 'local', groupId: 'canvas-group' }
    ]
  },
  terminalLayoutsByTabId: { terminal: { ptyIdsByLeafId: { [leaf]: 'pty' } } }
} as unknown as AppState
function seed(key = scope): CanvasDocument {
  const document: CanvasDocument = {
    ...emptyCanvasDocument(),
    nodes: [
      {
        id: 'agent',
        kind: 'agent',
        agentKey: JSON.stringify(['local', 'repo', 'folder', pane]),
        title: 'Codex',
        content: '',
        position: { x: 0, y: 0 },
        width: 480,
        height: 360
      }
    ]
  }
  localStorage.setItem(CANVAS_STORAGE_PREFIX + key, JSON.stringify(document))
  return document
}
beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('agent-created canvas browsers', () => {
  it('adds the native browser ID next to its exact agent and connects them', () => {
    seed()
    const target = resolveBrowserCanvasTarget(state, 'folder', pane)!
    expect(target.groupId).toBe('canvas-group')
    addCreatedBrowserToCanvas(target, 'browser-workspace', 'http://localhost:3000')
    addCreatedBrowserToCanvas(target, 'browser-workspace', 'http://localhost:3000')
    const view = renderHook(() => useAgentCanvasDocument(scope))
    const document = view.result.current.document
    expect(document.nodes).toHaveLength(2)
    expect(document.nodes[1]).toMatchObject({
      browserTabId: 'browser-workspace',
      position: { x: 544, y: 0 }
    })
    expect(document.edges).toEqual([
      {
        id: expect.any(String),
        source: document.nodes[1].id,
        target: 'agent',
        kind: 'browser-control'
      }
    ])
  })
  it('preserves unsaved edits in a mounted canvas and persists when hidden', () => {
    seed()
    const view = renderHook(() => useAgentCanvasDocument(scope))
    act(() =>
      view.result.current.update((doc) => ({
        ...doc,
        nodes: doc.nodes.map((node) => ({ ...node, title: 'Unsaved title' }))
      }))
    )
    act(() =>
      addCreatedBrowserToCanvas(
        resolveBrowserCanvasTarget(state, 'folder', pane)!,
        'first',
        'about:blank'
      )
    )
    expect(view.result.current.document.nodes[0].title).toBe('Unsaved title')
    expect(view.result.current.document.nodes).toHaveLength(2)
    view.unmount()
    addCreatedBrowserToCanvas(
      resolveBrowserCanvasTarget(state, 'folder', pane)!,
      'second',
      'about:blank'
    )
    const restored = renderHook(() => useAgentCanvasDocument(scope))
    expect(restored.result.current.document.nodes).toHaveLength(3)
  })
  it('does not attach another pane, workspace, host, or an ambient CLI', () => {
    seed()
    expect(resolveBrowserCanvasTarget(state, 'folder')).toBeNull()
    expect(resolveBrowserCanvasTarget(state, 'other', pane)).toBeNull()
    expect(
      resolveBrowserCanvasTarget(state, 'folder', 'terminal:22222222-2222-4222-8222-222222222222')
    ).toBeNull()
    const foreign = structuredClone(state)
    foreign.unifiedTabsByWorktree.folder[0].executionHostId = 'ssh:other'
    expect(resolveBrowserCanvasTarget(foreign, 'folder', pane)).toBeNull()
  })
  it('binds a launching tab only when it has exactly one matching pane', () => {
    const doc = seed()
    delete doc.nodes[0].agentKey
    doc.nodes[0].agentTabId = 'terminal'
    localStorage.setItem(CANVAS_STORAGE_PREFIX + scope, JSON.stringify(doc))
    expect(resolveBrowserCanvasTarget(state, 'folder', pane)).not.toBeNull()
    const split = structuredClone(state)
    split.terminalLayoutsByTabId.terminal.ptyIdsByLeafId!.other = 'other-pty'
    expect(resolveBrowserCanvasTarget(split, 'folder', pane)).toBeNull()
  })
  it('resolves restored legacy terminal ownership through its workspace host', () => {
    seed()
    const legacy = structuredClone(state)
    delete legacy.unifiedTabsByWorktree.folder[0].executionHostId
    legacy.activeWorktreeId = 'folder'
    legacy.activeWorkspaceExecutionHostId = 'local'
    expect(resolveBrowserCanvasTarget(legacy, 'folder', pane)).not.toBeNull()
    legacy.activeWorkspaceExecutionHostId = 'ssh:other'
    expect(resolveBrowserCanvasTarget(legacy, 'folder', pane)).toBeNull()
  })
  it('refuses ambiguous or unreadable canvases before creating a page', () => {
    seed()
    const secondScope = JSON.stringify(['workspace-tab', 'local', 'folder', 'second'])
    seed(secondScope)
    const multiple = structuredClone(state)
    multiple.unifiedTabsByWorktree.folder.push({
      ...multiple.unifiedTabsByWorktree.folder[1],
      id: 'second'
    })
    expect(() => resolveBrowserCanvasTarget(multiple, 'folder', pane)).toThrow('multiple canvases')
    localStorage.setItem(CANVAS_STORAGE_PREFIX + scope, '{broken')
    expect(() => resolveBrowserCanvasTarget(state, 'folder', pane)).toThrow('preserved')
    expect(localStorage.getItem(CANVAS_STORAGE_PREFIX + scope)).toBe('{broken')
  })
})
