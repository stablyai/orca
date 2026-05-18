import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerRuntimeTerminalTab,
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'
import type { AppState } from '../store/types'
import type { TerminalTab } from '../../../shared/types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    ...overrides
  } as AppState
}

function makeTerminalTab(): TerminalTab {
  return {
    id: 'term-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.unstubAllGlobals()
})

describe('scheduleRuntimeGraphSync', () => {
  it('coalesces updates that arrive while the runtime graph IPC is in flight', async () => {
    const syncCalls: {
      promise: Promise<void>
      resolve: (value: void | PromiseLike<void>) => void
    }[] = []
    const syncWindowGraph = vi.fn(() => {
      const call = deferred<void>()
      syncCalls.push(call)
      return call.promise
    })
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const unregister = registerRuntimeTerminalTab({
      tabId: 'term-1',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null
    })
    setRuntimeGraphStoreStateGetter(() =>
      makeState({
        tabsByWorktree: { 'wt-1': [makeTerminalTab()] } as AppState['tabsByWorktree']
      })
    )

    setRuntimeGraphSyncEnabled(true)
    await flushMicrotasks()

    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    scheduleRuntimeGraphSync()
    scheduleRuntimeGraphSync()
    await flushMicrotasks()

    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    syncCalls[0]?.resolve()
    await flushMicrotasks()

    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
    syncCalls[1]?.resolve()
    unregister()
  })
})
