import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from './store-test-helpers'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const createWebRuntimeSessionTerminalMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock,
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

const pairedWebFlag = globalThis as { __ORCA_WEB_CLIENT__?: boolean }

function seedActiveWorkspace(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    activeWorktreeId: 'wt-1',
    settings: { activeRuntimeEnvironmentId: 'runtime-1' } as AppState['settings'],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })]
    },
    groupsByWorktree: {
      'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' }
  })
}

describe('Cmd+J lifted creation actions', () => {
  beforeEach(() => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    createWebRuntimeSessionBrowserTabMock.mockReset()
    createWebRuntimeSessionTerminalMock.mockReset()
  })

  afterEach(() => {
    delete pairedWebFlag.__ORCA_WEB_CLIENT__
  })

  it('does not fall back to a local browser tab when paired-web creation fails', async () => {
    // Why: a remote-owned workspace must stay remote-owned. If the remote host
    // cannot create the page, we must NOT silently open a local desktop tab —
    // that produces confusing split ownership (issue #5321). Mirrors the
    // terminal no-fallback contract below.
    createWebRuntimeSessionBrowserTabMock.mockResolvedValue(false)
    const store = createTestStore()
    seedActiveWorkspace(store)

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'runtime-1',
      url: 'about:blank',
      targetGroupId: 'group-1'
    })
    expect(store.getState().browserTabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('routes browser tab creation to the explicit owner runtime when another runtime is focused', async () => {
    createWebRuntimeSessionBrowserTabMock.mockResolvedValue(false)
    const store = createTestStore()
    seedActiveWorkspace(store)
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:owner-runtime' }],
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as AppState['settings']
    })

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'owner-runtime',
      url: 'about:blank',
      targetGroupId: 'group-1'
    })
    // Remote-owned: no local fallback even when the remote create fails.
    expect(store.getState().browserTabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('creates a local browser tab for explicitly local workspaces while a runtime is focused', async () => {
    createWebRuntimeSessionBrowserTabMock.mockResolvedValue(false)
    const store = createTestStore()
    seedActiveWorkspace(store)
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'local' }],
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' } as AppState['settings']
    })

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
    expect(store.getState().browserTabsByWorktree['wt-1'] ?? []).toHaveLength(1)
  })

  it('does not fall back to a local terminal tab when paired-web creation fails', async () => {
    createWebRuntimeSessionTerminalMock.mockResolvedValue(false)
    const store = createTestStore()
    seedActiveWorkspace(store)

    await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'runtime-1',
      targetGroupId: 'group-1',
      activate: true
    })
    expect(store.getState().tabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('creates desktop remote-server terminal tabs through the owning runtime', async () => {
    delete pairedWebFlag.__ORCA_WEB_CLIENT__
    createWebRuntimeSessionTerminalMock.mockResolvedValue(false)
    const store = createTestStore()
    seedActiveWorkspace(store)
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:owner-runtime' }],
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })

    await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'owner-runtime',
      targetGroupId: 'group-1',
      activate: true
    })
    expect(store.getState().tabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('keeps desktop terminal creation local when a local worktree overrides a runtime repo owner', async () => {
    delete pairedWebFlag.__ORCA_WEB_CLIENT__
    createWebRuntimeSessionTerminalMock.mockResolvedValue(false)
    const store = createTestStore()
    seedActiveWorkspace(store)
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:owner-runtime' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local' })]
      },
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })

    await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionTerminalMock).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree['wt-1'] ?? []).toHaveLength(1)
  })
})
