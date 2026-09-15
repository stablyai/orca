// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, act, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { useWorkspaceViewTransfer } from './cross-project-panes/use-workspace-view-transfer'
import type { WorkspaceViewBridge } from '../../../shared/workspace-view-bridge'
import type { WorkspaceViewPacket } from './cross-project-panes/workspace-view-packet'
import { WorkspaceViewTransfer } from '../../../shared/workspace-view-transfer'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { captureEditorView, registerEditorView } from './editor/editor-view-transfer'
import { getDiskBaselineSignature } from './editor/diff-content-signature'
import { waitForWorkspaceViewSessions } from './cross-project-panes/workspace-view-session-readiness'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({ runtimeId: 'owner' }))
}))
const initial = useAppStore.getState()
let request: Parameters<WorkspaceViewBridge['onRequest']>[0]
beforeEach(() => {
  const domWindow = window
  const api = createTabsSliceMockApi()
  globalThis.window = domWindow
  Object.assign(window, {
    api,
    orcaWorkspaceViews: {
      ready: vi.fn(async () => 1),
      registerViews: vi.fn(async () => {}),
      onRequest: (callback: typeof request) => {
        request = callback
        return () => {}
      }
    }
  })
  Object.assign(window.api, {
    session: { patch: vi.fn(async () => {}), flush: vi.fn(async () => {}) }
  })
  useAppStore.setState(initial, true)
  useAppStore.setState({ workspaceSessionReady: true })
})
afterEach(cleanup)

describe('renderer transfer acknowledgement', () => {
  it('keeps provisional transfer changes out of undo/reopen history until commit', async () => {
    useAppStore.setState({ activeWorktreeId: 'project' })
    useAppStore.getState().createUnifiedTab('project', 'terminal', { executionHostId: 'local' })
    useAppStore.getState().initializeWindowPanes()
    renderHook(useWorkspaceViewTransfer)
    const original = useAppStore.getState().windowPaneLayout!
    await request('capture', { id: 'provisional' })
    await request('remove', { id: 'provisional' })
    expect(useAppStore.getState().workspaceLayoutHistory).toEqual([])
    expect(useAppStore.getState().closedWorkspaceViews).toEqual([])
    await request('restore', { id: 'provisional' })
    await request('finish', { id: 'provisional', succeeded: false })
    expect(Object.keys(useAppStore.getState().windowPaneLayout!.views)).toEqual(
      Object.keys(original.views)
    )
    expect(useAppStore.getState().workspaceLayoutHistory).toEqual([])
  })

  it('commits one correlated source transaction and reverses it idempotently', async () => {
    useAppStore.setState({ activeWorktreeId: 'project' })
    useAppStore.getState().createUnifiedTab('project', 'terminal', { executionHostId: 'local' })
    useAppStore.getState().initializeWindowPanes()
    renderHook(useWorkspaceViewTransfer)
    const original = useAppStore.getState().windowPaneLayout!
    await request('capture', { id: 'committed' })
    await request('remove', { id: 'committed' })
    await request('finish', { id: 'committed', succeeded: true, transaction: true })
    expect(useAppStore.getState().workspaceLayoutHistory).toHaveLength(1)
    expect(useAppStore.getState().workspaceLayoutHistory[0]).toMatchObject({
      transferId: 'committed'
    })
    useAppStore.setState({ workspaceLayoutHistory: [] })
    expect(await request('prepare-undo-transfer', { id: 'committed' })).toBe(true)
    expect(await request('undo-transfer', { id: 'committed' })).toBe(true)
    expect(await request('undo-transfer', { id: 'committed' })).toBe(true)
    expect(useAppStore.getState().windowPaneLayout).toEqual(original)
    expect(useAppStore.getState().workspaceLayoutHistory).toEqual([])
  })
  it('rejects undo for a transaction that was never committed', async () => {
    renderHook(useWorkspaceViewTransfer)
    expect(await request('prepare-undo-transfer', { id: 'missing' })).toBe(false)
    expect(await request('undo-transfer', { id: 'missing' })).toBe(false)
  })
  it('rechecks sessions arriving on another host while a host lookup is pending', async () => {
    useAppStore.getState().createUnifiedTab('unrelated', 'terminal', { executionHostId: 'local' })
    let resolve!: (value: unknown) => void
    vi.mocked(callRuntimeRpc).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const pending = waitForWorkspaceViewSessions(
      {
        views: [
          {
            view: {
              id: 'view',
              tabId: 'tab',
              entityId: 'shell',
              worktreeId: 'project',
              executionHostId: 'runtime:later',
              contentType: 'terminal'
            },
            owner: 'owner',
            session: 'shell',
            paneId: 'pane',
            selected: true
          }
        ]
      },
      new AbortController().signal
    )
    useAppStore.getState().createUnifiedTab('project', 'terminal', {
      executionHostId: 'runtime:later',
      entityId: 'shell'
    })
    resolve({ runtimeId: 'owner' })
    await expect(pending).resolves.toMatchObject({ 'runtime:later': 'owner' })
  })
  it('registers readiness after hydration and waits for the imported session inventory', async () => {
    useAppStore.setState({ activeWorktreeId: 'project', workspaceSessionReady: false })
    renderHook(useWorkspaceViewTransfer)
    await act(async () => {})
    expect(window.orcaWorkspaceViews!.ready).not.toHaveBeenCalled()
    act(() => useAppStore.setState({ workspaceSessionReady: true }))
    await waitFor(() => expect(window.orcaWorkspaceViews!.ready).toHaveBeenCalled())
    const packet: WorkspaceViewPacket = {
      views: [
        {
          view: {
            id: 'incoming',
            tabId: 'source-tab',
            entityId: 'shell',
            worktreeId: 'project',
            executionHostId: 'local',
            contentType: 'terminal'
          },
          owner: 'owner',
          session: 'shell',
          paneId: 'source',
          selected: true
        }
      ]
    }
    const settled = vi.fn()
    const importing = request('import', { id: 'delayed-inventory', packet, mode: 'tabs' })
    void importing.then(settled, settled)
    await act(async () => {})
    expect(settled).not.toHaveBeenCalled()
    act(() =>
      useAppStore
        .getState()
        .createUnifiedTab('project', 'terminal', { executionHostId: 'local', entityId: 'shell' })
    )
    await act(async () => {
      await expect(importing).resolves.toBe(true)
    })
    expect(
      Object.values(useAppStore.getState().windowPaneLayout!.views).some(
        (view) => view.entityId === 'shell'
      )
    ).toBe(true)
  })
  it('rechecks SSH contact after a pending owner lookup before removing source', async () => {
    useAppStore.setState({
      activeWorktreeId: 'project',
      sshConnectionStates: new Map([['ssh-host', { status: 'connected' } as never]])
    })
    useAppStore
      .getState()
      .createUnifiedTab('project', 'terminal', { executionHostId: 'ssh:ssh-host' })
    useAppStore.getState().initializeWindowPanes()
    renderHook(useWorkspaceViewTransfer)
    await request('capture', { id: 'pending-owner' })
    const original = useAppStore.getState().windowPaneLayout
    let resolve!: (value: unknown) => void
    vi.mocked(callRuntimeRpc).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const removing = request('remove', { id: 'pending-owner' })
    act(() => useAppStore.setState({ sshConnectionStates: new Map() }))
    resolve({ runtimeId: 'owner' })
    await expect(removing).rejects.toThrow('Session unavailable')
    expect(useAppStore.getState().windowPaneLayout).toBe(original)
  })
  it('retains a source whose SSH owner disconnects during import', async () => {
    useAppStore.setState({
      activeWorktreeId: 'project',
      sshConnectionStates: new Map([['ssh-host', { status: 'connected' } as never]])
    })
    useAppStore
      .getState()
      .createUnifiedTab('project', 'terminal', { executionHostId: 'ssh:ssh-host' })
    useAppStore.getState().initializeWindowPanes()
    renderHook(useWorkspaceViewTransfer)
    await request('capture', { id: 'offline' })
    const original = useAppStore.getState().windowPaneLayout
    act(() => useAppStore.setState({ sshConnectionStates: new Map() }))
    await expect(request('remove', { id: 'offline' })).rejects.toThrow('Session unavailable')
    expect(useAppStore.getState().windowPaneLayout).toBe(original)
  })
  function prepareEditor() {
    useAppStore.setState({
      activeWorktreeId: 'project',
      openFiles: [
        {
          id: 'draft',
          worktreeId: 'project',
          filePath: '/draft.txt',
          relativePath: 'draft.txt',
          mode: 'edit',
          language: 'plaintext',
          isDirty: true
        }
      ],
      editorDrafts: { draft: 'unsaved' }
    })
    useAppStore
      .getState()
      .createUnifiedTab('project', 'editor', { executionHostId: 'local', entityId: 'draft' })
    useAppStore.getState().initializeWindowPanes()
    renderHook(useWorkspaceViewTransfer)
  }
  it('retains edits made while the final owner lookup is pending', async () => {
    prepareEditor()
    await request('capture', { id: 'pending-draft' })
    let resolve!: (value: unknown) => void
    vi.mocked(callRuntimeRpc).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const removing = request('remove', { id: 'pending-draft' })
    act(() => useAppStore.setState({ editorDrafts: { draft: 'late typing' } }))
    resolve({ runtimeId: 'owner' })
    await expect(removing).resolves.toBe(false)
    expect(Object.keys(useAppStore.getState().windowPaneLayout!.views)).toHaveLength(1)
  })
  it('persists the source presentation before removal acknowledges', async () => {
    prepareEditor()
    await request('capture', { id: 'move' })
    vi.mocked(window.api.ui.set).mockClear()
    await act(async () => {
      expect(await request('remove', { id: 'move' })).toBe(true)
    })
    expect(window.api.ui.set).toHaveBeenCalledWith({
      windowPaneLayout: useAppStore.getState().windowPaneLayout
    })
  })
  it('persists the imported draft and preserves destination edits on rollback', async () => {
    prepareEditor()
    const packet = (await request('capture', { id: 'move' })) as WorkspaceViewPacket
    const original = useAppStore.getState().windowPaneLayout!
    act(() => {
      useAppStore
        .getState()
        .closeWorkspaceView(original.activePaneId, Object.keys(original.views)[0])
    })
    await act(async () => {
      await request('import', { id: 'move', packet, mode: 'panes' })
    })
    expect(window.api.session.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        openFilesByWorktree: {
          project: [expect.objectContaining({ dirtyDraftContent: 'unsaved' })]
        }
      })
    )
    const importedLayout = useAppStore.getState().windowPaneLayout!
    act(() => useAppStore.setState({ editorDrafts: { draft: 'destination typed' } }))
    await act(async () => {
      await request('rollback', { id: 'move' })
    })
    expect(useAppStore.getState().editorDrafts.draft).toBe('destination typed')
    expect(useAppStore.getState().windowPaneLayout).toBe(importedLayout)
  })
  it.each([
    [true, 'stored'],
    [true, 'live'],
    [true, 'unchanged'],
    [false, 'stored'],
    [false, 'live'],
    [false, 'unchanged']
  ] as const)('rolls back an initially dirty=%s import with %s content', async (dirty, edit) => {
    prepareEditor()
    act(() =>
      useAppStore.setState({
        openFiles: useAppStore.getState().openFiles.map((file) => ({
          ...file,
          isDirty: dirty,
          lastKnownDiskSignature: getDiskBaselineSignature('disk text')
        })),
        editorDrafts: dirty ? { draft: 'unsaved' } : {}
      })
    )
    const packet = (await request('capture', { id: 'rollback-editor' })) as WorkspaceViewPacket
    const original = useAppStore.getState().windowPaneLayout!
    act(() =>
      useAppStore
        .getState()
        .closeWorkspaceView(original.activePaneId, Object.keys(original.views)[0])
    )
    await act(async () => {
      await request('import', { id: 'rollback-editor', packet, mode: 'panes' })
    })
    const imported = useAppStore.getState().windowPaneLayout!
    const viewId = Object.keys(imported.views)[0]
    let text = dirty ? 'unsaved' : 'disk text'
    let version = 1
    const selection = { selection: { from: 2, to: 4 }, scrollTop: 17 }
    const unregister = registerEditorView(viewId, () => ({
      text,
      version,
      state: null,
      rich: selection
    }))
    try {
      if (edit !== 'unchanged') {
        text = 'destination typed'
        version++
      }
      if (edit === 'stored') {
        act(() => useAppStore.setState({ editorDrafts: { draft: text } }))
      }
      const drafts = useAppStore.getState().editorDrafts
      await act(async () => {
        expect(
          await new WorkspaceViewTransfer().run('rollback-editor', {
            import: async () => {},
            isDestinationLive: () => true,
            remove: () => false,
            rollback: async () => {
              await request('rollback', { id: 'rollback-editor' })
            }
          })
        ).toBe(false)
      })
      const layout = useAppStore.getState().windowPaneLayout!
      expect(Boolean(layout.views[viewId])).toBe(edit !== 'unchanged')
      if (edit !== 'unchanged') {
        expect(layout.panes[imported.activePaneId].viewIds).toContain(viewId)
        expect(layout.panes[imported.activePaneId].selectedViewId).toBe(viewId)
        expect(captureEditorView(viewId)).toEqual({ text, version, state: null, rich: selection })
      }
      expect(useAppStore.getState().editorDrafts).toBe(drafts)
    } finally {
      unregister()
    }
  })
  it('uses the same canonical owner for direct SSH and its runtime mirror', async () => {
    useAppStore.setState({
      activeWorktreeId: 'project',
      sshConnectionStates: new Map([['ssh-host', { status: 'connected' } as never]])
    })
    useAppStore.getState().createUnifiedTab('project', 'terminal', {
      executionHostId: 'ssh:ssh-host',
      entityId: 'terminal'
    })
    useAppStore.getState().initializeWindowPanes()
    renderHook(useWorkspaceViewTransfer)
    const packet = (await request('capture', { id: 'ssh' })) as WorkspaceViewPacket
    act(() => {
      useAppStore.setState({ unifiedTabsByWorktree: {}, windowPaneLayout: null })
      useAppStore.getState().createUnifiedTab('project', 'terminal', {
        executionHostId: 'runtime:loopback',
        entityId: 'terminal'
      })
    })
    await act(async () => {
      await expect(request('import', { id: 'ssh', packet, mode: 'tabs' })).resolves.toBe(true)
    })
  })
})

describe('workspace view transfer', () => {
  it('keeps the acknowledged destination if source removal acknowledgement is lost', async () => {
    const rollback = vi.fn()
    expect(
      await new WorkspaceViewTransfer().run('lost-ack', {
        import: async () => {},
        isDestinationLive: () => true,
        remove: async () => {
          throw new Error('Reply lost after source removed')
        },
        rollback
      })
    ).toBe(false)
    expect(rollback).not.toHaveBeenCalled()
  })
  it('removes the source only after the whole destination import acknowledges', async () => {
    const calls: string[] = []
    let acknowledge!: () => void
    const destination = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    const transfer = new WorkspaceViewTransfer()
    const run = transfer.run('move', {
      import: async () => {
        calls.push('import')
        await destination
      },
      isDestinationLive: () => true,
      remove: () => {
        calls.push('remove')
        return true
      },
      rollback: () => {
        calls.push('rollback')
      }
    })
    expect(calls).toEqual(['import'])
    acknowledge()
    expect(await run).toBe(true)
    expect(calls).toEqual(['import', 'remove'])
  })

  it.each(['offline owner', 'failed draft import'])('retains the source on %s', async (reason) => {
    const remove = vi.fn()
    const rollback = vi.fn()
    expect(
      await new WorkspaceViewTransfer().run('move', {
        import: async () => {
          throw new Error(reason)
        },
        isDestinationLive: () => true,
        remove,
        rollback
      })
    ).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('retains the source if the destination closes before acknowledgement', async () => {
    const remove = vi.fn()
    expect(
      await new WorkspaceViewTransfer().run('move', {
        import: async () => {},
        isDestinationLive: () => false,
        remove,
        rollback: vi.fn()
      })
    ).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  })

  it('rolls back all imported panes if the source changed during import', async () => {
    const rollback = vi.fn()
    expect(
      await new WorkspaceViewTransfer().run('combine', {
        import: async () => {},
        isDestinationLive: () => true,
        remove: () => false,
        rollback
      })
    ).toBe(false)
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('does not replay a completed or concurrent transaction', async () => {
    const transfer = new WorkspaceViewTransfer()
    const operations = {
      import: vi.fn(async () => {}),
      isDestinationLive: () => true,
      remove: vi.fn(() => true),
      rollback: vi.fn()
    }
    const first = transfer.run('same-id', operations)
    expect(await transfer.run('same-id', operations)).toBe(false)
    expect(await first).toBe(true)
    expect(await transfer.run('same-id', operations)).toBe(false)
    expect(operations.remove).toHaveBeenCalledOnce()
  })
})
