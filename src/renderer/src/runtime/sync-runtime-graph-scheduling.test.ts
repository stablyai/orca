import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRuntimeMobileSessionSyncKey,
  hasRegisteredRuntimeTerminalTab,
  registerRuntimeTerminalTab,
  runtimeMobileSessionSyncKeysEqual,
  flushRuntimeGraphSync,
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'
import type { AppState } from '../store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
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

async function flushRuntimeGraphSyncTimer(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20)
  await flushMicrotasks()
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runtime terminal registration ownership', () => {
  it('ignores stale cleanup after a replacement registers the same tab', () => {
    const first = registerRuntimeTerminalTab({
      tabId: 'term-replaced',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    const second = registerRuntimeTerminalTab({
      tabId: 'term-replaced',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })

    first()
    expect(hasRegisteredRuntimeTerminalTab('term-replaced')).toBe(true)

    second()
    expect(hasRegisteredRuntimeTerminalTab('term-replaced')).toBe(false)
  })
})

describe('scheduleRuntimeGraphSync', () => {
  it('coalesces updates that arrive while the runtime graph IPC is in flight', async () => {
    vi.useFakeTimers()
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
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    setRuntimeGraphStoreStateGetter(() =>
      makeState({
        tabsByWorktree: { 'wt-1': [makeTerminalTab()] } as AppState['tabsByWorktree']
      })
    )

    setRuntimeGraphSyncEnabled(true)
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    scheduleRuntimeGraphSync()
    scheduleRuntimeGraphSync()
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    syncCalls[0]?.resolve()
    await flushMicrotasks()
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
    syncCalls[1]?.resolve()
    unregister()
  })

  it('coalesces updates that arrive before the frame timer fires', async () => {
    vi.useFakeTimers()
    const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const unregister = registerRuntimeTerminalTab({
      tabId: 'term-1',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    setRuntimeGraphStoreStateGetter(() =>
      makeState({
        tabsByWorktree: { 'wt-1': [makeTerminalTab()] } as AppState['tabsByWorktree']
      })
    )

    setRuntimeGraphSyncEnabled(true)
    scheduleRuntimeGraphSync()
    await flushMicrotasks()
    scheduleRuntimeGraphSync()

    expect(syncWindowGraph).toHaveBeenCalledTimes(0)
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    unregister()
  })

  it('flushes a fresh graph immediately and waits for main acceptance', async () => {
    vi.useFakeTimers()
    const publication = deferred<void>()
    const syncWindowGraph = vi.fn(() => publication.promise)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    const unregister = registerRuntimeTerminalTab({
      tabId: 'term-1',
      worktreeId: 'wt-1',
      getManager: () => null,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    setRuntimeGraphStoreStateGetter(() => makeState())
    setRuntimeGraphSyncEnabled(true)

    let settled = false
    const flush = flushRuntimeGraphSync('wt-1').then(() => {
      settled = true
    })
    await flushMicrotasks()
    expect(syncWindowGraph).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    publication.resolve()
    await flush
    expect(settled).toBe(true)
    unregister()
  })

  it('retries one requested mobile resync before acknowledging', async () => {
    vi.useFakeTimers()
    const syncWindowGraph = vi
      .fn()
      .mockResolvedValueOnce({ mobileSessionResyncWorktrees: ['wt-1'] })
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    setRuntimeGraphStoreStateGetter(() => makeState())
    setRuntimeGraphSyncEnabled(true)

    await flushRuntimeGraphSync('wt-1')

    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
  })

  it('rejects a publication failure while background scheduling keeps its catch behavior', async () => {
    vi.useFakeTimers()
    const failure = new Error('publication_failed')
    const syncWindowGraph = vi.fn().mockRejectedValue(failure)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    setRuntimeGraphStoreStateGetter(() => makeState())
    setRuntimeGraphSyncEnabled(true)

    await expect(flushRuntimeGraphSync('wt-1')).rejects.toThrow('publication_failed')
    scheduleRuntimeGraphSync()
    await flushRuntimeGraphSyncTimer()
    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
  })
})

describe('getRuntimeMobileSessionSyncKey scheduling inputs', () => {
  it('changes when only tab group split ratios change', () => {
    const base = makeState({
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' },
          ratio: 0.5
        }
      } as AppState['layoutByWorktree']
    })
    const baseKey = getRuntimeMobileSessionSyncKey(base)
    const resized = makeState({
      ...base,
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' },
          ratio: 0.65
        }
      } as AppState['layoutByWorktree']
    })

    const resizedKey = getRuntimeMobileSessionSyncKey(resized, base, baseKey)

    expect(runtimeMobileSessionSyncKeysEqual(baseKey, resizedKey)).toBe(false)
  })
})
