import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hydrateTerminalScrollbackRefs } from '../../../components/terminal-pane/snapshots/terminal-scrollback-ref-hydration'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  HOST_TERMINAL_SCROLLBACK_HOLD_MS,
  resetHostTerminalScrollbackHydrationForTests,
  startHostTerminalScrollbackHydration,
  type HostTerminalScrollbackHydrationDeps,
  type HostTerminalScrollbackTabState
} from './host-terminal-scrollback-hydration'

vi.mock('@/store/index', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('../../../web/preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => null
}))

const REF = `v1-${'c'.repeat(32)}`

function layout(overrides: Partial<TerminalLayoutSnapshot> = {}): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: 'leaf-1' },
    activeLeafId: 'leaf-1',
    expandedLeafId: null,
    scrollbackRefsByLeafId: { 'leaf-1': REF },
    ...overrides
  }
}

function harness(overrides: Partial<HostTerminalScrollbackHydrationDeps> = {}) {
  const tabState: HostTerminalScrollbackTabState = {
    layout: layout(),
    localOnly: undefined
  }
  const deps = {
    getTabState: vi.fn(() => tabState),
    resolveEnvironmentId: vi.fn((_worktreeId: string): string | null => 'env-wsl'),
    readLocalSnapshot: vi.fn(async (_ref: string): Promise<string | null> => null),
    peekHostSupportsRead: vi.fn((_environmentId: string): boolean | undefined => true),
    warmHostSupportsRead: vi.fn(async (_environmentId: string): Promise<unknown> => true),
    readHostSnapshot: vi.fn(
      async (_environmentId: string, _worktreeId: string, _ref: string, _signal: AbortSignal) =>
        'host history'
    ),
    isTabMounted: vi.fn((_tabId: string) => false),
    storeLocalOnly: vi.fn((tabId: string, buffers: Record<string, string>) => {
      void tabId
      tabState.localOnly = buffers
    }),
    ...overrides
  }
  return { deps, tabState }
}

beforeEach(() => {
  resetHostTerminalScrollbackHydrationForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startHostTerminalScrollbackHydration', () => {
  it('restores slow local history while the replaced pane is still mounted without writing a session', async () => {
    vi.useFakeTimers()
    let finish!: (buffer: string) => void
    const { deps, tabState } = harness({
      resolveEnvironmentId: () => null,
      isTabMounted: () => true,
      readLocalSnapshot: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    tabState.layout = layout({ ptyIdsByLeafId: { 'leaf-1': 'daemon-pty' } })
    const pending = startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)!
    await vi.advanceTimersByTimeAsync(HOST_TERMINAL_SCROLLBACK_HOLD_MS + 1)
    finish('saved full-screen frame')
    const captured = await pending.ready
    expect(
      hydrateTerminalScrollbackRefs(tabState.layout!, captured).layout.buffersByLeafId
    ).toEqual({ 'leaf-1': 'saved full-screen frame' })
    expect(deps.storeLocalOnly).not.toHaveBeenCalled()
    expect(deps.readHostSnapshot).not.toHaveBeenCalled()
  })

  it('uses local bytes even when the host has no snapshot capability and preserves newer park bytes', async () => {
    let finish!: (buffer: string) => void
    const { deps, tabState } = harness({
      peekHostSupportsRead: () => false,
      readLocalSnapshot: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    const pending = startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)!
    await Promise.resolve()
    await Promise.resolve()
    finish('local history')
    const captured = await pending.ready
    expect(
      hydrateTerminalScrollbackRefs(tabState.layout!, captured).layout.buffersByLeafId
    ).toEqual({ 'leaf-1': 'local history' })
    const changed = layout({ scrollbackRefsByLeafId: { 'leaf-1': 'new-ref' } })
    expect(hydrateTerminalScrollbackRefs(changed, captured).layout.buffersByLeafId).toBeUndefined()
    const parked = layout({ buffersByLeafId: { 'leaf-1': 'newer park history' } })
    expect(hydrateTerminalScrollbackRefs(parked, captured).layout.buffersByLeafId).toEqual({
      'leaf-1': 'newer park history'
    })
    expect(deps.readHostSnapshot).not.toHaveBeenCalled()
  })

  it('commits validated bytes before a later queued ref update can invalidate their handoff', async () => {
    const { deps, tabState } = harness({
      resolveEnvironmentId: () => null,
      readLocalSnapshot: async () => 'history at the commit boundary'
    })
    let mountedBuffers: Record<string, string> | undefined
    const pending = startHostTerminalScrollbackHydration(
      'tab-1',
      'repo::/wt',
      deps,
      () => true,
      (snapshots) => {
        mountedBuffers = hydrateTerminalScrollbackRefs(tabState.layout!, snapshots).layout
          .buffersByLeafId
      }
    )!
    void pending.local.then(() => {
      queueMicrotask(() => {
        tabState.layout = layout({ scrollbackRefsByLeafId: { 'leaf-1': 'later-ref' } })
      })
    })
    await pending.ready
    expect(tabState.layout?.scrollbackRefsByLeafId).toEqual({ 'leaf-1': 'later-ref' })
    expect(mountedBuffers).toEqual({ 'leaf-1': 'history at the commit boundary' })
  })

  it('restores host history after a failed local read', async () => {
    const { deps, tabState } = harness({
      readLocalSnapshot: async () => {
        throw new Error('unreadable')
      }
    })
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)?.ready
    expect(tabState.localOnly).toEqual({ 'leaf-1': 'host history' })
  })

  it('releases the host deadline when its mount retires', async () => {
    vi.useFakeTimers()
    const { deps } = harness({ readHostSnapshot: () => new Promise<string>(() => {}) })
    const pending = startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)!
    await vi.advanceTimersByTimeAsync(0)
    pending.retire()
    await pending.ready
    expect(vi.getTimerCount()).toBe(0)
    expect(deps.storeLocalOnly).not.toHaveBeenCalled()
  })

  it('keeps one host deadline when the saved ref changes during fallback', async () => {
    vi.useFakeTimers()
    const replies = new Map<string, (buffer: string) => void>()
    const signals: AbortSignal[] = []
    const { deps, tabState } = harness({
      readHostSnapshot: (_environment, _worktree, ref, signal) => {
        signals.push(signal)
        return new Promise<string>((resolve) => replies.set(ref, resolve))
      }
    })
    const pending = startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)!
    await vi.advanceTimersByTimeAsync(2_000)
    tabState.layout = layout({ scrollbackRefsByLeafId: { 'leaf-1': 'changed-ref' } })
    replies.get(REF)!('obsolete host history')
    await vi.advanceTimersByTimeAsync(0)
    expect(replies.has('changed-ref')).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await pending.ready
    expect(signals[1].aborted).toBe(true)
    replies.get('changed-ref')!('late changed history')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.storeLocalOnly).not.toHaveBeenCalled()
  })

  it('aborts the read when the hold bound passes and drops late bytes', async () => {
    vi.useFakeTimers()
    let observed: AbortSignal | undefined
    const { deps } = harness({
      readHostSnapshot: vi.fn(
        (_environmentId: string, _worktreeId: string, _ref: string, signal: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            observed = signal
            signal.addEventListener('abort', () => {
              resolve('late history')
              reject(new Error('aborted'))
            })
          })
      )
    })
    const pending = startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    await vi.advanceTimersByTimeAsync(HOST_TERMINAL_SCROLLBACK_HOLD_MS)
    await pending?.ready
    expect(observed?.aborted).toBe(true)
    expect(deps.storeLocalOnly).not.toHaveBeenCalled()
    vi.mocked(deps.readHostSnapshot).mockResolvedValueOnce('retry history')
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)?.ready
    expect(deps.storeLocalOnly).toHaveBeenCalledWith('tab-1', {
      'leaf-1': 'retry history'
    })
  })
})
