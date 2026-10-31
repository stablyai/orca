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
const callRuntimeRpc = vi.hoisted(() => vi.fn(async () => ({ started: true })))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

const PANE_KEY = 'tab-1:leaf-1'

function session(): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait reads only these session members.
  return {
    cacheKey: PANE_KEY,
    disposed: false,
    waitTeardowns: [],
    pane: { id: 1, leafId: 'leaf-1' },
    deps: { tabId: 'tab-1', worktreeId: 'wt-1', onPtyErrorRef: { current: vi.fn() } }
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

  // Main held background work on a stopped distro (E9): the pane shows the shared Start card.
  it("shows main's stopped-distro hold as the Start card, which asks main to start it", async () => {
    const { waitsForMainPaneStart } = await import('./main-pane-start-wait')
    const { wslDistroStoppedHoldStore, startHeldPanesForWslDistro } =
      await import('../wsl-distro-stopped-hold-state')
    const pane = session()
    store.setStarts({ [PANE_KEY]: { status: 'starting' } })

    waitsForMainPaneStart(pane, vi.fn(), vi.fn())
    store.setStarts({
      [PANE_KEY]: { status: 'failed', reason: 'terminal_held_wsl_distro_stopped:Ubuntu' }
    })

    expect(pane.deps.onPtyErrorRef?.current).not.toHaveBeenCalled()
    expect(wslDistroStoppedHoldStore.getState().panes[PANE_KEY]).toMatchObject({
      distro: 'Ubuntu',
      state: 'stopped'
    })
    startHeldPanesForWslDistro('Ubuntu')
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'layout.startWslHeldPanes', {
      panes: [{ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' }]
    })
    expect(wslDistroStoppedHoldStore.getState().panes[PANE_KEY]).toBeUndefined()
  })

  it("clears the card once main's start ends another way", async () => {
    const { waitsForMainPaneStart } = await import('./main-pane-start-wait')
    const { wslDistroStoppedHoldStore } = await import('../wsl-distro-stopped-hold-state')
    const pane = session()
    store.setStarts({ [PANE_KEY]: { status: 'starting' } })
    const connect = vi.fn()

    waitsForMainPaneStart(pane, connect)
    store.setStarts({
      [PANE_KEY]: { status: 'failed', reason: 'terminal_held_wsl_distro_stopped:Ubuntu' }
    })
    store.setStarts({})

    expect(connect).toHaveBeenCalledOnce()
    expect(wslDistroStoppedHoldStore.getState().panes[PANE_KEY]).toBeUndefined()
  })

  it('carries an unchecked distro to the card as unverifiable', async () => {
    const { waitsForMainPaneStart } = await import('./main-pane-start-wait')
    const { wslDistroStoppedHoldStore } = await import('../wsl-distro-stopped-hold-state')
    const pane = session()
    store.setStarts({ [PANE_KEY]: { status: 'starting' } })

    waitsForMainPaneStart(pane, vi.fn(), vi.fn())
    store.setStarts({
      [PANE_KEY]: { status: 'failed', reason: 'terminal_held_wsl_distro_unverifiable:Ubuntu' }
    })

    expect(wslDistroStoppedHoldStore.getState().panes[PANE_KEY]).toMatchObject({
      distro: 'Ubuntu',
      state: 'unverifiable'
    })
    expect(pane.deps.onPtyErrorRef?.current).not.toHaveBeenCalled()
  })
})
