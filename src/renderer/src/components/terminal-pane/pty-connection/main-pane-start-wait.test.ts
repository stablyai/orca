import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type Starts = Record<string, { status: string; reason?: string }>

const store = vi.hoisted(() => {
  let state: { terminalPaneStartsByPaneKey: Starts; terminalLayoutsByTabId: object } = {
    terminalPaneStartsByPaneKey: {},
    terminalLayoutsByTabId: {}
  }
  const listeners = new Set<(next: typeof state) => void>()
  return {
    getState: () => state,
    subscribe: (listener: (next: typeof state) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setStarts: (starts: Starts) => {
      state = { ...state, terminalPaneStartsByPaneKey: starts }
      for (const listener of listeners) {
        listener(state)
      }
    }
  }
})

vi.mock('@/store', () => ({ useAppStore: store }))
vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const PANE_KEY = 'tab-1:leaf-1'

function session(): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait reads only these session members.
  return {
    cacheKey: PANE_KEY,
    disposed: false,
    waitTeardowns: [],
    pane: { id: 1, leafId: 'leaf-1' },
    deps: { tabId: 'tab-1', onPtyErrorRef: { current: vi.fn() } }
  } as unknown as ConnectPanePtySession
}

describe('waitsForMainPaneStart', () => {
  beforeEach(() => {
    store.setStarts({})
  })

  it('runs every waiter once main’s start ends', async () => {
    const { waitsForMainPaneStart } = await import('./main-pane-start-wait')
    const pane = session()
    store.setStarts({ [PANE_KEY]: { status: 'starting' } })
    const first = vi.fn()
    const second = vi.fn()

    expect(waitsForMainPaneStart(pane, first)).toBe(true)
    expect(waitsForMainPaneStart(pane, second)).toBe(true)
    store.setStarts({})

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('tells each waiter when main shows the start failed', async () => {
    const { waitsForMainPaneStart } = await import('./main-pane-start-wait')
    const pane = session()
    store.setStarts({ [PANE_KEY]: { status: 'starting' } })
    const failedFirst = vi.fn()
    const failedLater = vi.fn()

    waitsForMainPaneStart(pane, vi.fn(), failedFirst)
    store.setStarts({ [PANE_KEY]: { status: 'failed', reason: 'spawn exploded' } })
    waitsForMainPaneStart(pane, vi.fn(), failedLater)

    expect(failedFirst).toHaveBeenCalledOnce()
    expect(failedLater).toHaveBeenCalledOnce()
    expect(pane.deps.onPtyErrorRef?.current).toHaveBeenCalledWith(
      1,
      'The terminal could not start: spawn exploded'
    )
  })
  // A start main could not bind shows its reason through this wait.
  it('shows terminal_not_started from main through the wait', async () => {
    const { waitsForMainPaneStart } = await import('./main-pane-start-wait')
    const pane = session()
    store.setStarts({ [PANE_KEY]: { status: 'starting' } })
    const failed = vi.fn()

    waitsForMainPaneStart(pane, vi.fn(), failed)
    store.setStarts({ [PANE_KEY]: { status: 'failed', reason: 'terminal_not_started' } })

    expect(failed).toHaveBeenCalledOnce()
    expect(pane.deps.onPtyErrorRef?.current).toHaveBeenCalledWith(
      1,
      'The terminal could not start: terminal_not_started'
    )
  })
})
