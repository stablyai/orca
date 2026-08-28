import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRuntimeMobileSessionSyncKey,
  hasRegisteredRuntimeTerminalTab,
  registerRuntimeTerminalTab,
  runtimeMobileSessionSyncKeysEqual,
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

describe('runtime graph publication retry', () => {
  it('keeps store updates behind the active retry backoff', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const syncWindowGraph = vi
      .fn()
      .mockRejectedValueOnce(new Error('rejected'))
      .mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    setRuntimeGraphStoreStateGetter(() => makeState())

    setRuntimeGraphSyncEnabled(true)
    await flushRuntimeGraphSyncTimer()
    expect(syncWindowGraph).toHaveBeenCalledTimes(1)

    scheduleRuntimeGraphSync()
    await vi.advanceTimersByTimeAsync(499)
    expect(syncWindowGraph).toHaveBeenCalledTimes(1)

    await flushRuntimeGraphSyncTimer()
    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
  })

  it('keeps an update received by a failing publication behind its retry backoff', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectFirstSync: (reason?: unknown) => void = () => {}
    const firstSync = new Promise<void>((_resolve, reject) => {
      rejectFirstSync = reject
    })
    const syncWindowGraph = vi.fn().mockReturnValueOnce(firstSync).mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    setRuntimeGraphStoreStateGetter(() => makeState())

    setRuntimeGraphSyncEnabled(true)
    await flushRuntimeGraphSyncTimer()
    scheduleRuntimeGraphSync()
    rejectFirstSync(new Error('rejected'))
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(499)
    expect(syncWindowGraph).toHaveBeenCalledTimes(1)

    await flushRuntimeGraphSyncTimer()
    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
  })

  it('republishes after main rejects a publication, with no store change to ride on', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const syncWindowGraph = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Runtime graph publisher belongs to a superseded renderer generation')
      )
      .mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    setRuntimeGraphStoreStateGetter(() => makeState())

    setRuntimeGraphSyncEnabled(true)
    await flushRuntimeGraphSyncTimer()
    expect(syncWindowGraph).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(600)
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
  })

  it('stops retrying once a publication is accepted', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const syncWindowGraph = vi
      .fn()
      .mockRejectedValueOnce(new Error('rejected'))
      .mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    setRuntimeGraphStoreStateGetter(() => makeState())

    setRuntimeGraphSyncEnabled(true)
    await flushRuntimeGraphSyncTimer()
    await vi.advanceTimersByTimeAsync(600)
    await flushRuntimeGraphSyncTimer()
    expect(syncWindowGraph).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(120_000)
    await flushRuntimeGraphSyncTimer()

    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
  })
})
