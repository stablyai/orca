import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import {
  HOST_TERMINAL_SCROLLBACK_HOLD_MS,
  resetHostTerminalScrollbackHydrationForTests,
  startHostTerminalScrollbackHydration,
  type HostTerminalScrollbackHydrationDeps,
  type HostTerminalScrollbackTabState
} from './host-terminal-scrollback-hydration'
import { createWebWorkspaceSessionApi } from '../web/preload-api/web-workspace-session-api'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('../web/preload-api/web-runtime-session', () => ({
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
    hasLocalSnapshot: vi.fn((_ref: string) => false),
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

function rpcFailure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('startHostTerminalScrollbackHydration', () => {
  it('reads a host-run pane from its host when this client has no copy', async () => {
    const { deps, tabState } = harness()
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(deps.peekHostSupportsRead).toHaveBeenCalledWith('env-wsl')
    expect(deps.warmHostSupportsRead).not.toHaveBeenCalled()
    expect(deps.readHostSnapshot).toHaveBeenCalledExactlyOnceWith(
      'env-wsl',
      'repo::/wt',
      REF,
      expect.any(AbortSignal)
    )
    expect(tabState.localOnly).toEqual({ 'leaf-1': 'host history' })
  })

  it('mounts at once on a host cached as not advertising the read', () => {
    const { deps } = harness({ peekHostSupportsRead: vi.fn(() => false) })
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()
    expect(deps.warmHostSupportsRead).not.toHaveBeenCalled()
    expect(deps.readHostSnapshot).not.toHaveBeenCalled()
  })

  it('holds on an unknown host, warms its status once per environment, then reads', async () => {
    let known: boolean | undefined
    const { deps, tabState } = harness({
      peekHostSupportsRead: vi.fn(() => known),
      warmHostSupportsRead: vi.fn(async () => {
        known = true
        return true
      })
    })
    const first = startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    const second = startHostTerminalScrollbackHydration('tab-2', 'repo::/wt', deps)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    await Promise.all([first, second])
    expect(deps.warmHostSupportsRead).toHaveBeenCalledExactlyOnceWith('env-wsl')
    expect(deps.readHostSnapshot).toHaveBeenCalledTimes(2)
    expect(tabState.localOnly).toEqual({ 'leaf-1': 'host history' })
  })

  it('reads nothing when the warmed status says the host lacks the read', async () => {
    let known: boolean | undefined
    const { deps } = harness({
      peekHostSupportsRead: vi.fn(() => known),
      warmHostSupportsRead: vi.fn(async () => {
        known = false
        return false
      })
    })
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(deps.readHostSnapshot).not.toHaveBeenCalled()
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()
  })

  it('reads nothing when the status probe fails', async () => {
    const { deps } = harness({
      peekHostSupportsRead: vi.fn(() => undefined),
      warmHostSupportsRead: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(deps.readHostSnapshot).not.toHaveBeenCalled()
  })

  it('skips a leaf bound to a live PTY, whose screen replaces restored history', () => {
    const { deps, tabState } = harness()
    tabState.layout = layout({ ptyIdsByLeafId: { 'leaf-1': 'pty-1' } })
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()
    expect(deps.hasLocalSnapshot).not.toHaveBeenCalled()
    expect(deps.peekHostSupportsRead).not.toHaveBeenCalled()
  })

  it('never asks a host for a pane this machine runs', () => {
    const { deps } = harness({ resolveEnvironmentId: vi.fn(() => null) })
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()
    expect(deps.peekHostSupportsRead).not.toHaveBeenCalled()
    expect(deps.hasLocalSnapshot).not.toHaveBeenCalled()
  })

  it('keeps using the local copy, stat-checked once per ref', () => {
    const { deps } = harness({ hasLocalSnapshot: vi.fn(() => true) })
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()
    expect(deps.hasLocalSnapshot).toHaveBeenCalledExactlyOnceWith(REF)
    expect(deps.peekHostSupportsRead).not.toHaveBeenCalled()
  })

  it('skips leaves that already carry bytes', () => {
    const { deps, tabState } = harness()
    tabState.layout = layout({ buffersByLeafId: { 'leaf-1': 'shared' } })
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()
    tabState.layout = layout()
    tabState.localOnly = { 'leaf-1': 'parked' }
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()
  })

  it('shares an in-flight read and retries after a transport failure', async () => {
    const readHostSnapshot = vi.fn(async (): Promise<string> => {
      throw new Error('host unreachable')
    })
    const { deps, tabState } = harness({ readHostSnapshot })
    const first = startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBe(first)
    await first
    expect(deps.storeLocalOnly).not.toHaveBeenCalled()
    readHostSnapshot.mockResolvedValue('after reconnect')
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(readHostSnapshot).toHaveBeenCalledTimes(2)
    expect(tabState.localOnly).toEqual({ 'leaf-1': 'after reconnect' })
  })

  it('never asks again after a not-found answer or stored bytes', async () => {
    const { deps } = harness({
      readHostSnapshot: vi.fn(async (): Promise<string> => {
        throw rpcFailure('terminal_scrollback_not_found')
      })
    })
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).toBeNull()

    const stored = harness()
    await startHostTerminalScrollbackHydration('tab-2', 'repo::/wt', stored.deps)
    stored.tabState.localOnly = undefined
    expect(startHostTerminalScrollbackHydration('tab-2', 'repo::/wt', stored.deps)).toBeNull()
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
    await pending
    expect(observed?.aborted).toBe(true)
    expect(deps.storeLocalOnly).not.toHaveBeenCalled()
    // An abort is not a definite answer, so a later mount may try again.
    expect(startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)).not.toBeNull()
  })

  it('does not write under a pane that mounted while the read was in flight', async () => {
    const { deps } = harness({ isTabMounted: vi.fn(() => true) })
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(deps.storeLocalOnly).not.toHaveBeenCalled()
  })

  it('drops bytes for a leaf whose ref changed during the read', async () => {
    const state: { current: HostTerminalScrollbackTabState | null } = {
      current: null
    }
    const { deps, tabState } = harness({
      readHostSnapshot: vi.fn(async () => {
        if (state.current) {
          state.current.layout = layout({
            scrollbackRefsByLeafId: { 'leaf-1': `v1-${'d'.repeat(32)}` }
          })
        }
        return 'stale history'
      })
    })
    state.current = tabState
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(deps.storeLocalOnly).not.toHaveBeenCalled()
  })

  it('reads from the host on a web client, whose preload has no snapshot store', async () => {
    const webSession = createWebWorkspaceSessionApi().session
    expect(webSession).toBeDefined()
    const { deps, tabState } = harness({
      hasLocalSnapshot: (ref) => webSession?.hasTerminalScrollback({ ref }) ?? false
    })
    await startHostTerminalScrollbackHydration('tab-1', 'repo::/wt', deps)
    expect(deps.readHostSnapshot).toHaveBeenCalledOnce()
    expect(tabState.localOnly).toEqual({ 'leaf-1': 'host history' })
  })
})
