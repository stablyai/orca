import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/workspace-layout/terminal-tab-types'
import {
  HOST_TERMINAL_SCROLLBACK_HOLD_MS,
  resetHostTerminalScrollbackHydrationForTests,
  startHostTerminalScrollbackHydration,
  type HostTerminalScrollbackHydrationDeps,
  type HostTerminalScrollbackTabState
} from './host-terminal-scrollback-hydration'

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

describe('startHostTerminalScrollbackHydration', () => {
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
})
