// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { Tab } from '../../../../shared/tab-types'
import { canvasAgentKey, emptyCanvasDocument, type CanvasDocument } from './agent-canvas-document'

const mocks = vi.hoisted(() => ({ call: vi.fn(), route: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  hasRuntimeRpcErrorCode: (error: { code?: string }, code: string) => error.code === code
}))
vi.mock('@/lib/worktree-operation-route', () => ({
  resolveWorktreeOperationRouteResultForHost: mocks.route,
  settingsForWorktreeOperationRoute: () => ({})
}))
const scope = JSON.stringify(['workspace-tab', 'local', 'workspace', 'canvas'])
const card = {
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'pty',
  repoId: 'repo',
  worktreeId: 'workspace',
  executionHostId: 'local',
  agentType: 'codex'
} as DashboardCard
const document: CanvasDocument = {
  ...emptyCanvasDocument(),
  nodes: [
    {
      id: 'agent',
      kind: 'agent',
      agentKey: canvasAgentKey(card),
      agentTabId: card.tabId,
      title: 'Codex',
      content: '',
      position: { x: 0, y: 0 },
      width: 480,
      height: 360
    },
    {
      id: 'note',
      kind: 'note',
      title: 'Reference',
      content: 'My reference',
      position: { x: 0, y: 0 },
      width: 300,
      height: 240
    }
  ],
  edges: [{ id: 'edge', source: 'note', target: 'agent' }]
}
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  mocks.call.mockReset().mockImplementation(async (_target, _method, request) => ({
    revision: request.revision,
    nodes: { agent: { provider: 'codex', state: 'ready' } }
  }))
  mocks.route.mockReset().mockReturnValue({ kind: 'resolved', route: {} })
  localStorage.clear()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('canvas context synchronization', () => {
  it.each(['pause', 'disconnect'] as const)(
    'publishes %s for A/B even when C with a connected note becomes unavailable',
    async (edit) => {
      const { CanvasAgentContextStore } =
        await import('../../../../shared/canvas-agent-context-store')
      const store = new CanvasAgentContextStore()
      const identity = { sessionId: 'original', launchTokenHash: 'a'.repeat(64) }
      mocks.call.mockImplementation((_target, _method, request) =>
        store.replace(
          request,
          new Map(
            request.bindings.map((binding: { nodeId: string }) => [binding.nodeId, identity])
          ),
          request.deferredBindings
        )
      )
      const sync = await import('./canvas-context-sync')
      const cards = ['a', 'b', 'c'].map((id) => ({
        ...card,
        tabId: id,
        paneKey: `${id}:${card.leafId}`,
        ptyId: `${id}-pty`
      }))
      const canvas: CanvasDocument = {
        ...document,
        nodes: [
          document.nodes[1],
          ...cards.map((agent, index) => ({
            ...document.nodes[0],
            id: ['a', 'b', 'c'][index],
            agentKey: canvasAgentKey(agent),
            agentTabId: agent.tabId
          }))
        ],
        edges: [
          { id: 'ab', source: 'a', target: 'b' },
          { id: 'nc', source: 'note', target: 'c' }
        ]
      }
      sync.syncCanvasContext(scope, canvas, cards)
      await vi.advanceTimersByTimeAsync(200)
      sync.syncCanvasContext(
        scope,
        {
          ...canvas,
          collaborationPaused: edit === 'pause',
          edges: canvas.edges.filter((edge) => edit === 'pause' || edge.id !== 'ab')
        },
        cards.slice(0, 2)
      )
      await vi.advanceTimersByTimeAsync(200)
      expect(mocks.call).toHaveBeenCalledTimes(2)
      const request = mocks.call.mock.calls[1][2]
      expect(request.bindings).toHaveLength(2)
      expect(request.bindings[0]).toMatchObject({
        nodeId: 'a',
        peers: edit === 'pause' ? ['b'] : [],
        collaborationPaused: edit === 'pause'
      })
      expect(request.deferredBindings).toEqual([
        expect.objectContaining({ nodeId: 'c', notes: [expect.objectContaining({ id: 'note' })] })
      ])
      const saved = store.snapshot().get(scope)!.bindings
      expect(saved.find((binding) => binding.nodeId === 'a')).toMatchObject({
        peers: edit === 'pause' ? ['b'] : [],
        collaborationPaused: edit === 'pause'
      })
      expect(saved.find((binding) => binding.nodeId === 'c')?.identity).toEqual(identity)
      expect(sync.readCanvasContext(scope).nodes.a.state).toBe('ready')
      expect(sync.readCanvasContext(scope).error).toContain('unverifiable')
    }
  )
  it('registers bidirectional peers and a persisted pause without sharing terminal output', async () => {
    const sync = await import('./canvas-context-sync')
    const second = {
      ...card,
      tabId: 'second',
      paneKey: 'second:11111111-1111-4111-8111-111111111111',
      ptyId: 'second-pty'
    }
    sync.syncCanvasContext(
      scope,
      {
        ...document,
        collaborationPaused: true,
        nodes: [
          ...document.nodes,
          {
            ...document.nodes[0],
            id: 'second-agent',
            agentKey: canvasAgentKey(second),
            agentTabId: second.tabId
          }
        ],
        edges: [...document.edges, { id: 'collaboration', source: 'agent', target: 'second-agent' }]
      },
      [card, second]
    )
    await vi.advanceTimersByTimeAsync(200)
    const bindings = mocks.call.mock.calls[0][2].bindings
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'agent',
          peers: ['second-agent'],
          collaborationPaused: true
        }),
        expect.objectContaining({
          nodeId: 'second-agent',
          peers: ['agent'],
          notes: [],
          collaborationPaused: true
        })
      ])
    )
  })
  it('sends a debounced native snapshot, coalesces edits, and clears disconnected notes', async () => {
    const sync = await import('./canvas-context-sync')
    sync.syncCanvasContext(scope, document, [card])
    const edited = {
      ...document,
      nodes: document.nodes.map((node) =>
        node.kind === 'note' ? { ...node, content: 'Latest reference' } : node
      )
    }
    sync.syncCanvasContext(scope, edited, [card])
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.call.mock.calls[0][1]).toBe('agentHooks.canvasContextSync')
    expect(mocks.call.mock.calls[0][2].bindings[0].notes[0].content).toBe('Latest reference')
    expect(sync.readCanvasContext(scope).nodes.agent.state).toBe('ready')
    sync.syncCanvasContext(scope, { ...edited, edges: [] }, [card])
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.call.mock.calls[1][2].bindings).toEqual([
      expect.objectContaining({ nodeId: 'agent', notes: [] })
    ])
  })
  it('registers canvas agents without notes so they receive native browser guidance', async () => {
    const sync = await import('./canvas-context-sync')
    sync.syncCanvasContext(scope, { ...document, edges: [] }, [card])
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.call.mock.calls[0][2].bindings).toEqual([
      expect.objectContaining({ paneKey: card.paneKey, provider: 'codex', notes: [] })
    ])
    sync.syncCanvasContext(scope, emptyCanvasDocument(), [])
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.call.mock.calls[1][2].bindings).toEqual([])
  })
  it('does not report ready while offline, and resumes after reconnect', async () => {
    const sync = await import('./canvas-context-sync')
    sync.syncCanvasContext(scope, document, [card])
    await vi.advanceTimersByTimeAsync(200)
    mocks.route.mockReturnValue({ kind: 'unavailable' })
    sync.syncCanvasContext(scope, document, [card])
    expect(sync.readCanvasContext(scope).error).toContain('unverifiable')
    mocks.route.mockReturnValue({ kind: 'resolved', route: {} })
    sync.syncCanvasContext(scope, document, [card])
    await vi.advanceTimersByTimeAsync(200)
    expect(sync.readCanvasContext(scope).error).toBeNull()
    expect(mocks.call).toHaveBeenCalledTimes(2)
  })
  it('never substitutes a sibling terminal for an exact pane', async () => {
    const sync = await import('./canvas-context-sync')
    sync.syncCanvasContext(scope, document, [{ ...card, paneKey: 'tab:other', leafId: 'other' }])
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.call.mock.calls[0][2].bindings).toEqual([])
    expect(mocks.call.mock.calls[0][2].deferredBindings[0].nodeId).toBe('agent')
    expect(sync.readCanvasContext(scope).error).toContain('terminal')
  })
  it('does not enqueue invalid context on later polls', async () => {
    const sync = await import('./canvas-context-sync')
    const large = {
      ...document,
      nodes: document.nodes.map((node) =>
        node.kind === 'note' ? { ...node, content: 'x'.repeat(33_000) } : node
      )
    }
    for (let index = 0; index < 3; index++) {
      sync.syncCanvasContext(scope, large, [card])
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(mocks.call).not.toHaveBeenCalled()
    expect(sync.readCanvasContext(scope).error).toContain('limit')
  })
  it('reports unsupported on an older runtime instead of claiming delivery', async () => {
    const sync = await import('./canvas-context-sync')
    mocks.call.mockRejectedValue({ code: 'method_not_found' })
    sync.syncCanvasContext(scope, document, [card])
    await vi.advanceTimersByTimeAsync(200)
    expect(sync.readCanvasContext(scope).nodes.agent.state).toBe('unsupported')
  })
  it('allows closing on a proven unsupported host, including persisted canvases after reload', async () => {
    const sync = await import('./canvas-context-sync')
    localStorage.setItem(`orca.agent-canvas.v1:${scope}`, JSON.stringify(document))
    mocks.call.mockRejectedValue({ code: 'method_not_found' })
    const tab = { id: 'canvas', worktreeId: 'workspace', executionHostId: 'local' } as Tab
    await expect(sync.clearClosedCanvasContext(tab)).resolves.toBeUndefined()
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(sync.readCanvasContext(scope).nodes).toEqual({})
  })
  it.each(['timeout', 'connection_closed', 'permission_denied'])(
    'does not treat %s as unsupported when closing',
    async (code) => {
      const sync = await import('./canvas-context-sync')
      localStorage.setItem(`orca.agent-canvas.v1:${scope}`, JSON.stringify(document))
      mocks.call.mockRejectedValue({ code })
      const tab = { id: 'canvas', worktreeId: 'workspace', executionHostId: 'local' } as Tab
      await expect(sync.clearClosedCanvasContext(tab)).rejects.toEqual({ code })
    }
  )
  it('requires explicit session adoption; disconnecting and reconnecting never moves context', async () => {
    const { CanvasAgentContextStore } =
      await import('../../../../shared/canvas-agent-context-store')
    const { adoptCanvasAgentSession } = await import('./canvas-session-adoption')
    const store = new CanvasAgentContextStore()
    let identity = { sessionId: 'original', launchTokenHash: 'a'.repeat(64) }
    mocks.call.mockImplementation((_target, _method, request) =>
      store.replace(
        request,
        new Map(request.bindings.map((binding: { nodeId: string }) => [binding.nodeId, identity]))
      )
    )
    const sync = await import('./canvas-context-sync')
    sync.syncCanvasContext(scope, document, [card])
    await vi.advanceTimersByTimeAsync(200)
    identity = { sessionId: 'replacement', launchTokenHash: 'b'.repeat(64) }
    sync.syncCanvasContext(scope, { ...document, edges: [] }, [card])
    await vi.advanceTimersByTimeAsync(200)
    sync.syncCanvasContext(scope, document, [card])
    await vi.advanceTimersByTimeAsync(200)
    expect(sync.readCanvasContext(scope).nodes.agent.state).toBe('session-changed')
    const adopted = adoptCanvasAgentSession(document, 'agent')
    sync.syncCanvasContext(scope, adopted, [card])
    await vi.advanceTimersByTimeAsync(200)
    const newId = adopted.nodes[0].id
    expect(newId).not.toBe('agent')
    expect(adopted.edges[0].target).toBe(newId)
    expect(sync.readCanvasContext(scope).nodes[newId].state).toBe('ready')
    expect(store.snapshot().get(scope)?.bindings[0].identity).toMatchObject(identity)
    expect(store.snapshot().get(scope)?.bindings[0].notes[0].content).toBe('My reference')
    identity = { sessionId: 'yet-another', launchTokenHash: 'c'.repeat(64) }
    sync.syncCanvasContext(scope, adopted, [card], true)
    await vi.advanceTimersByTimeAsync(200)
    expect(sync.readCanvasContext(scope).nodes[newId].state).toBe('session-changed')
  })
  it('closes only after context removal is acknowledged, without reattaching during close', async () => {
    const sync = await import('./canvas-context-sync')
    sync.syncCanvasContext(scope, document, [card])
    await vi.advanceTimersByTimeAsync(200)
    mocks.call.mockImplementation(async (_target, _method, request) => ({
      revision: request.revision,
      nodes: {}
    }))
    const tab = { id: 'canvas', worktreeId: 'workspace', executionHostId: 'local' } as Tab
    const closing = sync.clearClosedCanvasContext(tab)
    sync.syncCanvasContext(scope, document, [card], true)
    await closing
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call.mock.calls[1][2].bindings).toEqual([])
    expect(sync.readCanvasContext(scope).nodes).toEqual({})
  })
  it('reconciles a higher host revision without claiming that old notes are current', async () => {
    const sync = await import('./canvas-context-sync')
    mocks.call.mockImplementationOnce(async (_target, _method, request) => ({
      revision: request.revision + 100,
      nodes: { agent: { provider: 'codex', state: 'ready' } }
    }))
    sync.syncCanvasContext(scope, document, [card])
    await vi.advanceTimersByTimeAsync(200)
    expect(sync.readCanvasContext(scope).error).toContain('Reconciling')
    sync.syncCanvasContext(scope, document, [card], true)
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.call.mock.calls[1][2].revision).toBeGreaterThan(
      mocks.call.mock.calls[0][2].revision + 100
    )
    expect(sync.readCanvasContext(scope).nodes.agent.state).toBe('ready')
  })
  it('does not send additional snapshots for position-only changes', async () => {
    const sync = await import('./canvas-context-sync')
    sync.syncCanvasContext(scope, document, [card])
    await vi.advanceTimersByTimeAsync(200)
    sync.syncCanvasContext(
      scope,
      {
        ...document,
        nodes: document.nodes.map((node) => ({ ...node, position: { x: 50, y: 60 } }))
      },
      [card]
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })
})
