import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeLayout, makeTab, seedStore } from '../slices/store-test-helpers'

import { resolveTerminalDetachTarget } from './terminal-detachment'

const detachedTerminalApi = {
  close: vi.fn(async () => undefined),
  open: vi.fn(async () => true),
  returnToMain: vi.fn(async () => undefined),
  onClosed: vi.fn(() => () => undefined)
}

describe('terminal detachment state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { api: { detachedTerminal: detachedTerminalApi } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('detaches a single-pane PTY and re-docks without changing tab ownership', async () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'Shell' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      }
    })

    await expect(store.getState().detachTerminalTab('tab-1')).resolves.toBe(true)

    expect(detachedTerminalApi.open).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      title: 'Shell'
    })
    expect(store.getState().detachedTerminalByTabId).toEqual({
      'tab-1': { ptyId: 'pty-1' }
    })
    expect(store.getState().tabsByWorktree['wt-1']).toHaveLength(1)

    store.getState().redockDetachedTerminalTab('tab-1')
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('does not detach tab when IPC open fails', async () => {
    detachedTerminalApi.open.mockResolvedValueOnce(false)
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'Shell' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      }
    })

    await expect(store.getState().detachTerminalTab('tab-1')).resolves.toBe(false)
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('truncates custom title to 512 characters when opening companion', async () => {
    const longTitle = 'x'.repeat(600)
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', customTitle: longTitle })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      }
    })

    await expect(store.getState().detachTerminalTab('tab-1')).resolves.toBe(true)
    expect(detachedTerminalApi.open).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      title: 'x'.repeat(512)
    })
    expect(store.getState().detachedTerminalByTabId).toEqual({
      'tab-1': { ptyId: 'pty-1' }
    })
  })

  it('closes companion and does not record detachment if tab is closed while opening', async () => {
    let resolveOpen: (value: boolean) => void
    detachedTerminalApi.open.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = resolve
        })
    )
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'Shell' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      }
    })

    const detachPromise = store.getState().detachTerminalTab('tab-1')

    store.getState().closeTab('tab-1')

    resolveOpen!(true)
    await expect(detachPromise).resolves.toBe(false)

    expect(detachedTerminalApi.close).toHaveBeenCalledWith('tab-1')
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('rejects a remote-runtime PTY because the companion has no paired-host transport', async () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [
          makeTab({
            id: 'tab-remote',
            worktreeId: 'wt-1',
            ptyId: 'remote:environment@@terminal'
          })
        ]
      }
    })

    const target = resolveTerminalDetachTarget(store.getState(), 'tab-remote')
    expect(target?.remoteUnsupported).toBe(true)

    await expect(store.getState().detachTerminalTab('tab-remote')).resolves.toBe(false)

    expect(detachedTerminalApi.open).not.toHaveBeenCalled()
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('rejects an SSH PTY because the companion has no remote transport', async () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [
          makeTab({
            id: 'tab-ssh',
            worktreeId: 'wt-1',
            ptyId: 'ssh:server@@remote-pty'
          })
        ]
      }
    })

    const target = resolveTerminalDetachTarget(store.getState(), 'tab-ssh')
    expect(target?.remoteUnsupported).toBe(true)

    await expect(store.getState().detachTerminalTab('tab-ssh')).resolves.toBe(false)

    expect(detachedTerminalApi.open).not.toHaveBeenCalled()
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('rejects a tab whose layout has more than one leaf (split terminal)', async () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-split', worktreeId: 'wt-1', title: 'Split' })]
      },
      terminalLayoutsByTabId: {
        'tab-split': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: 'leaf-1' },
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 'pty-2' }
        }
      }
    })

    const target = resolveTerminalDetachTarget(store.getState(), 'tab-split')
    expect(target?.splitUnsupported).toBe(true)

    await expect(store.getState().detachTerminalTab('tab-split')).resolves.toBe(false)

    expect(detachedTerminalApi.open).not.toHaveBeenCalled()
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('closes a companion when its terminal tab is closed', () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      detachedTerminalByTabId: { 'tab-1': { ptyId: 'pty-1' } }
    })

    store.getState().closeTab('tab-1')

    expect(detachedTerminalApi.close).toHaveBeenCalledWith('tab-1')
    expect(store.getState().tabsByWorktree['wt-1']).toEqual([])
  })

  it('falls back to tab ptyId when layout has no pty id', async () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-tab', title: 'Shell' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: {}
        }
      }
    })

    const target = resolveTerminalDetachTarget(store.getState(), 'tab-1')
    expect(target?.ptyId).toBe('pty-tab')

    await expect(store.getState().detachTerminalTab('tab-1')).resolves.toBe(true)
    expect(detachedTerminalApi.open).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-tab',
      title: 'Shell'
    })
    expect(store.getState().detachedTerminalByTabId).toEqual({
      'tab-1': { ptyId: 'pty-tab' }
    })
  })

  it('closes companion and does not record detachment if re-docked while opening', async () => {
    let resolveOpen: (value: boolean) => void
    detachedTerminalApi.open.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = resolve
        })
    )
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'Shell' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      }
    })

    const detachPromise = store.getState().detachTerminalTab('tab-1')

    store.getState().redockDetachedTerminalTab('tab-1')

    resolveOpen!(true)
    await expect(detachPromise).resolves.toBe(false)

    expect(detachedTerminalApi.close).toHaveBeenCalledWith('tab-1')
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('does not close companion when a newer pending open supersedes an earlier open', async () => {
    let resolveFirstOpen: (value: boolean) => void
    let resolveSecondOpen: (value: boolean) => void
    detachedTerminalApi.open
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstOpen = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveSecondOpen = resolve
          })
      )
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'Shell' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      }
    })

    const firstDetach = store.getState().detachTerminalTab('tab-1')
    const secondDetach = store.getState().detachTerminalTab('tab-1')

    resolveFirstOpen!(true)
    await expect(firstDetach).resolves.toBe(false)
    expect(detachedTerminalApi.close).not.toHaveBeenCalled()

    resolveSecondOpen!(true)
    await expect(secondDetach).resolves.toBe(true)
    expect(detachedTerminalApi.close).not.toHaveBeenCalled()
    expect(store.getState().detachedTerminalByTabId).toEqual({
      'tab-1': { ptyId: 'pty-1' }
    })
  })

  it('closes companion and does not record detachment if PTY is replaced while opening', async () => {
    let resolveOpen: (value: boolean) => void
    detachedTerminalApi.open.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = resolve
        })
    )
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'Shell' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      }
    })

    const detachPromise = store.getState().detachTerminalTab('tab-1')

    seedStore(store, {
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-2' }
        }
      }
    })

    resolveOpen!(true)
    await expect(detachPromise).resolves.toBe(false)

    expect(detachedTerminalApi.close).toHaveBeenCalledWith('tab-1')
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('closes companion and does not record detachment if tab is split while opening', async () => {
    let resolveOpen: (value: boolean) => void
    detachedTerminalApi.open.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = resolve
        })
    )
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'Shell' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      }
    })

    const detachPromise = store.getState().detachTerminalTab('tab-1')

    seedStore(store, {
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: 'leaf-1' },
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 'pty-2' }
        }
      }
    })

    resolveOpen!(true)
    await expect(detachPromise).resolves.toBe(false)

    expect(detachedTerminalApi.close).toHaveBeenCalledWith('tab-1')
    expect(store.getState().detachedTerminalByTabId).toEqual({})
  })

  it('does not invalidate pending open when another tab is re-docked', async () => {
    let resolveOpen: (value: boolean) => void
    detachedTerminalApi.open.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = resolve
        })
    )
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'tab-1', worktreeId: 'wt-1', title: 'Shell 1' }),
          makeTab({ id: 'tab-2', worktreeId: 'wt-1', title: 'Shell 2' })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        }
      },
      detachedTerminalByTabId: { 'tab-2': { ptyId: 'pty-2' } }
    })

    const detachPromise = store.getState().detachTerminalTab('tab-1')

    store.getState().redockDetachedTerminalTab('tab-2')

    resolveOpen!(true)
    await expect(detachPromise).resolves.toBe(true)

    expect(store.getState().detachedTerminalByTabId).toEqual({
      'tab-1': { ptyId: 'pty-1' }
    })
  })
})
