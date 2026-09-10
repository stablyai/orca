// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspaceCanvasDocument } from '../../../shared/maestro-workspace-document-state'
import {
  workspaceSurfaceKey,
  type WorkspaceSurface
} from '../../../shared/maestro-workspace-canvas'

const { query, mutate } = vi.hoisted(() => ({ query: vi.fn(), mutate: vi.fn() }))
vi.mock('@/runtime/runtime-maestro-workspace-client', () => ({
  getRuntimeMaestroWorkspaceCanvas: query,
  mutateRuntimeMaestroWorkspaceCanvas: mutate
}))

import {
  useMaestroWorkspaceCanvas,
  type MaestroWorkspaceCanvasResource
} from './useMaestroWorkspaceCanvas'

let root: Root | null = null
let container: HTMLDivElement | null = null
let resource: MaestroWorkspaceCanvasResource | null = null
const scope = { execution_host_id: 'local', workspace_key: 'folder:workspace-1' }
const target = { kind: 'local' as const }

function available(
  revision: number,
  exactScope = scope,
  surfaces: Record<string, WorkspaceSurface> = {}
) {
  return {
    status: 'available' as const,
    actor_id: 'actor-1',
    snapshot: {
      schema_version: 1 as const,
      protocol: 'workspace-surface-snapshot/v1' as const,
      ...exactScope,
      authority_revision: revision,
      authority_cursor: `cursor-${revision}`,
      state: 'ready' as const,
      surfaces,
      unsupported: [],
      automatic_links: [],
      suggested_links: [],
      capability: { available: true, reason: null },
      harness_overlay: null
    },
    canvas: { revision, document: emptyWorkspaceCanvasDocument(), updated_at: null }
  }
}

function terminalSurface(revision: number): WorkspaceSurface {
  return {
    id: { ...scope, unified_tab_id: 'terminal-1' },
    content_type: 'terminal',
    entity_id: 'terminal-1',
    group_id: 'group-1',
    title: 'Terminal 1',
    revision,
    availability: 'available',
    binding: {
      kind: 'terminal',
      terminal_tab_id: 'terminal-1',
      pane_key: 'terminal-1::leaf-1',
      session_id: 'session-1',
      pty_incarnation: 'pty-1',
      liveness: 'live',
      authority_revision: revision
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function Probe(): React.JSX.Element {
  resource = useMaestroWorkspaceCanvas(target, scope)
  return createElement('span', null, resource.status)
}

function ScopedProbe({ exactScope }: { exactScope: typeof scope }): React.JSX.Element {
  resource = useMaestroWorkspaceCanvas(target, exactScope)
  return createElement('span', null, resource.status)
}

beforeEach(() => {
  query.mockReset()
  mutate.mockReset()
  resource = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('useMaestroWorkspaceCanvas', () => {
  it('loads the exact workspace snapshot before reporting empty resources', async () => {
    query.mockResolvedValue(available(2))
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })
    expect(query).toHaveBeenCalledWith(target, scope)
    expect(resource?.status).toBe('ready')
    expect(resource?.result?.snapshot.authority_revision).toBe(2)
  })

  it('refreshes only after an authoritative applied mutation receipt', async () => {
    query.mockResolvedValueOnce(available(2)).mockResolvedValueOnce(available(3))
    mutate.mockResolvedValue({ status: 'applied', authority_revision: 3 })
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })
    await act(async () => {
      await resource?.mutate({
        action: 'create',
        surface_type: 'terminal',
        idempotency_key: 'create-1'
      })
    })
    expect(mutate).toHaveBeenCalledWith(target, {
      action: 'create',
      surface_type: 'terminal',
      idempotency_key: 'create-1',
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: 2
    })
    expect(resource?.result?.snapshot.authority_revision).toBe(3)
  })

  it('retries one stale mutation with fresh authority revisions and the same identity', async () => {
    const surface = terminalSurface(4)
    query
      .mockResolvedValueOnce(available(2))
      .mockResolvedValueOnce(available(3))
      .mockResolvedValueOnce(available(4, scope, { [workspaceSurfaceKey(surface.id)]: surface }))
    mutate
      .mockResolvedValueOnce({ status: 'stale', authority_revision: 3 })
      .mockResolvedValueOnce({ status: 'applied', authority_revision: 4 })
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })
    await act(async () => {
      await resource?.mutate({
        action: 'create',
        surface_type: 'terminal',
        idempotency_key: 'create-stale-1'
      })
    })
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls.map(([, request]) => request)).toMatchObject([
      { idempotency_key: 'create-stale-1', expected_authority_revision: 2 },
      { idempotency_key: 'create-stale-1', expected_authority_revision: 3 }
    ])
    expect(query).toHaveBeenCalledTimes(3)
    expect(resource?.result?.snapshot.surfaces).toHaveProperty(workspaceSurfaceKey(surface.id))
  })

  it('stops after two bounded stale retries and preserves the receipt', async () => {
    query
      .mockResolvedValueOnce(available(2))
      .mockResolvedValueOnce(available(3))
      .mockResolvedValueOnce(available(4))
    mutate
      .mockResolvedValueOnce({ status: 'stale', authority_revision: 3 })
      .mockResolvedValueOnce({ status: 'stale', authority_revision: 4 })
      .mockResolvedValueOnce({
        status: 'stale',
        authority_revision: 5,
        canvas_revision: 5,
        reason: 'canvas_revision_conflict'
      })
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })
    await act(async () => {
      await resource?.mutate({
        action: 'focus',
        surface_id: { ...scope, unified_tab_id: 'terminal-1' },
        idempotency_key: 'focus-stale-1'
      })
    })
    expect(mutate).toHaveBeenCalledTimes(3)
    expect(mutate.mock.calls[2][1]).toMatchObject({
      idempotency_key: 'focus-stale-1',
      expected_authority_revision: 4,
      expected_canvas_revision: 4
    })
    expect(resource?.mutation).toMatchObject({
      status: 'stale',
      reason: 'canvas_revision_conflict'
    })
  })

  it('serializes concurrent document mutations against the latest canvas revision', async () => {
    const firstMutation = deferred<{
      status: 'applied'
      authority_revision: number
      canvas_revision: number
    }>()
    query
      .mockResolvedValueOnce(available(1))
      .mockResolvedValueOnce(available(2))
      .mockResolvedValueOnce(available(3))
    mutate
      .mockReturnValueOnce(firstMutation.promise)
      .mockResolvedValueOnce({ status: 'applied', authority_revision: 3, canvas_revision: 3 })
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = resource!.mutate({
        action: 'set-viewport',
        viewport: { center: { x: 10, y: 20 }, zoom: 1.1 },
        idempotency_key: 'viewport-1'
      })
      second = resource!.mutate({
        action: 'set-viewport',
        viewport: { center: { x: 30, y: 40 }, zoom: 1.2 },
        idempotency_key: 'viewport-2'
      })
    })
    await Promise.resolve()
    expect(mutate).toHaveBeenCalledTimes(1)

    firstMutation.resolve({ status: 'applied', authority_revision: 2, canvas_revision: 2 })
    await act(async () => Promise.all([first, second]))

    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls[1]?.[1]).toMatchObject({
      idempotency_key: 'viewport-2',
      expected_authority_revision: 2,
      expected_canvas_revision: 2
    })
  })

  it('keeps last-known resources after an unknown close outcome', async () => {
    query.mockResolvedValue(available(2))
    mutate.mockResolvedValue({ status: 'outcome_unknown', authority_revision: 2 })
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })
    await act(async () => {
      await resource?.mutate({
        action: 'close',
        surface_id: { ...scope, unified_tab_id: 'tab-1' },
        idempotency_key: 'close-1'
      })
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(resource?.result?.snapshot.authority_revision).toBe(2)
    expect(resource?.mutation?.status).toBe('outcome_unknown')
  })

  it('polls external tab changes and cancels the timer on unmount', async () => {
    vi.useFakeTimers()
    query.mockResolvedValue(available(2))
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })
    expect(query).toHaveBeenCalledTimes(2)
    act(() => root?.unmount())
    const calls = query.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(query).toHaveBeenCalledTimes(calls)
    vi.useRealTimers()
  })

  it('ignores an out-of-order explicit refresh response', async () => {
    query.mockResolvedValueOnce(available(2))
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })
    const older = deferred<ReturnType<typeof available>>()
    const newer = deferred<ReturnType<typeof available>>()
    query.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const first = resource!.refresh()
    const second = resource!.refresh()
    newer.resolve(available(4))
    await act(async () => second)
    older.resolve(available(3))
    await act(async () => first)
    expect(resource?.result?.snapshot.authority_revision).toBe(4)
  })

  it('ignores an old workspace response after the scope changes', async () => {
    const oldScope = { ...scope, workspace_key: 'folder:old' }
    const newScope = { ...scope, workspace_key: 'folder:new' }
    const oldResponse = deferred<ReturnType<typeof available>>()
    query.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(available(1, newScope))
    await act(async () => {
      root?.render(createElement(ScopedProbe, { exactScope: oldScope }))
      await Promise.resolve()
    })
    await act(async () => {
      root?.render(createElement(ScopedProbe, { exactScope: newScope }))
      await Promise.resolve()
    })
    oldResponse.resolve(available(9, oldScope))
    await act(async () => oldResponse.promise)
    expect(resource?.result?.snapshot.workspace_key).toBe(newScope.workspace_key)
  })

  it('ignores a late mutation result after the workspace changes', async () => {
    const oldScope = { ...scope, workspace_key: 'folder:old' }
    const newScope = { ...scope, workspace_key: 'folder:new' }
    const oldMutation = deferred<{
      status: 'outcome_unknown'
      authority_revision: number
      reason: string
    }>()
    query
      .mockResolvedValueOnce(available(1, oldScope))
      .mockResolvedValueOnce(available(1, newScope))
    mutate.mockReturnValueOnce(oldMutation.promise)

    await act(async () => {
      root?.render(createElement(ScopedProbe, { exactScope: oldScope }))
      await Promise.resolve()
    })
    let pendingMutation!: Promise<void>
    act(() => {
      pendingMutation = resource!.mutate({
        action: 'create',
        surface_type: 'terminal',
        idempotency_key: 'old-workspace-mutation'
      })
    })
    await Promise.resolve()
    await act(async () => {
      root?.render(createElement(ScopedProbe, { exactScope: newScope }))
      await Promise.resolve()
    })

    oldMutation.resolve({
      status: 'outcome_unknown',
      authority_revision: 1,
      reason: 'old workspace command failed'
    })
    await act(async () => pendingMutation)

    expect(resource?.result?.snapshot.workspace_key).toBe(newScope.workspace_key)
    expect(resource?.mutation).toBeNull()
  })

  it('does not start a queued mutation after unmount', async () => {
    const firstMutation = deferred<{
      status: 'applied'
      authority_revision: number
    }>()
    query.mockResolvedValueOnce(available(1))
    mutate.mockReturnValueOnce(firstMutation.promise)
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })

    let first!: Promise<void>
    let queued!: Promise<void>
    act(() => {
      first = resource!.mutate({
        action: 'create',
        surface_type: 'terminal',
        idempotency_key: 'first-before-unmount'
      })
      queued = resource!.mutate({
        action: 'create',
        surface_type: 'terminal',
        idempotency_key: 'queued-before-unmount'
      })
    })
    await Promise.resolve()
    act(() => root?.unmount())
    firstMutation.resolve({ status: 'applied', authority_revision: 2 })
    await act(async () => Promise.all([first, queued]))

    expect(mutate).toHaveBeenCalledOnce()
  })

  it('does not retry a stale mutation after unmount', async () => {
    const staleRefresh = deferred<ReturnType<typeof available>>()
    query.mockResolvedValueOnce(available(1)).mockReturnValueOnce(staleRefresh.promise)
    mutate.mockResolvedValueOnce({ status: 'stale', authority_revision: 2 })
    await act(async () => {
      root?.render(createElement(Probe))
      await Promise.resolve()
    })

    let pending!: Promise<void>
    act(() => {
      pending = resource!.mutate({
        action: 'create',
        surface_type: 'terminal',
        idempotency_key: 'stale-before-unmount'
      })
    })
    await Promise.resolve()
    act(() => root?.unmount())
    staleRefresh.resolve(available(2))
    await act(async () => pending)

    expect(mutate).toHaveBeenCalledOnce()
  })
})
