// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type StoreView = {
  activeView: string
  activeWorktreeId: string
  activeTabType: string
  activeTabId: string | null
  activeGroupIdByWorktree: Record<string, string>
  unifiedTabsByWorktree: Record<string, never[]>
}
const store = vi.hoisted(() => {
  const view: StoreView = {
    activeView: 'terminal',
    activeWorktreeId: 'repo::/wt',
    activeTabType: 'terminal',
    activeTabId: null,
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {}
  }
  return { ...view, transferAgentPaneAuthority: vi.fn(), closeTab: vi.fn() }
})
const refreshSnapshot = vi.hoisted(() => vi.fn(async () => {}))
const focusSurface = vi.hoisted(() => vi.fn())
/** The host as the transport reaches it: which runtime answers, and what it holds. */
type HostState = {
  runtimeId: string
  tabs: { parentTabId: string; leafId: string }[]
  unreachable: boolean
  routedEnvironmentId: string | null
}
const host = vi.hoisted(() => {
  const state: HostState = {
    runtimeId: 'runtime-1',
    tabs: [],
    unreachable: false,
    routedEnvironmentId: 'env-1'
  }
  return state
})
const pairing = vi.hoisted(() => ({ revision: 1 }))

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: refreshSnapshot
}))
vi.mock('../../rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => pairing.revision
}))
vi.mock('../../../lib/workspace/ownership/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => host.routedEnvironmentId
}))
vi.mock('../../../components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusSurface
}))

const { settleHostPaneMove } = await import('./web-runtime-leaf-move')

const REQUEST = {
  worktreeId: 'repo::/wt',
  sourceTabId: 'source-tab',
  targetTabId: 'drawn-tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'pty-1'
}

const AUTHORITY = {
  environmentId: 'env-1',
  pairingRevision: 1,
  runtimeId: 'runtime-1',
  worktreeId: REQUEST.worktreeId
}

const call = vi.fn(
  async (args: {
    expectedEnvironmentRuntimeId?: string
    expectedEnvironmentPairingRevision?: number
  }) => {
    if (host.unreachable) {
      throw new Error('no route to host')
    }
    // As main does: a call pinned to a runtime that is gone is refused before it is sent.
    if (args.expectedEnvironmentRuntimeId !== host.runtimeId) {
      return {
        id: 'session.tabs.list',
        ok: false,
        error: { code: 'runtime_environment_changed', message: 'changed' },
        _meta: { runtimeId: host.runtimeId }
      }
    }
    return {
      id: 'session.tabs.list',
      ok: true,
      result: { tabs: host.tabs },
      _meta: { runtimeId: host.runtimeId }
    }
  }
)

beforeEach(() => {
  vi.clearAllMocks()
  host.runtimeId = 'runtime-1'
  host.tabs = []
  host.unreachable = false
  host.routedEnvironmentId = 'env-1'
  pairing.revision = 1
  store.activeView = 'terminal'
  store.activeTabId = null
  Object.assign(window, { api: { runtimeEnvironments: { call } } })
})

const movedHereStays = () => expect(store.closeTab).not.toHaveBeenCalled()

describe('settling a pane move with its host', () => {
  it('undoes a refused move without stopping its terminal, then tells the user', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', true, { onRefused })

    expect(store.closeTab).toHaveBeenCalledWith(
      'drawn-tab',
      expect.objectContaining({
        localPtyTeardownOwnedExternally: true,
        remoteCloseOwnedByHost: true
      })
    )
    expect(onRefused).toHaveBeenCalledTimes(1)
  })

  it('keeps a move the host committed', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'moved', true, { onRefused })

    movedHereStays()
    expect(onRefused).not.toHaveBeenCalled()
  })

  it('undoes a move whose reply was lost and the host does not hold, without a failure message', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, { onRefused }, 0)
    // Let the one later check run (the host still does not hold it).
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(store.closeTab).toHaveBeenCalledTimes(1)
    expect(onRefused).not.toHaveBeenCalled()
  })

  it('redraws a lost-reply move the host commits after saying it did not hold it', async () => {
    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, {}, 0)
    host.tabs = [{ parentTabId: 'drawn-tab', leafId: REQUEST.leafId }]

    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(2))
  })

  it('asks a host it could not reach once more, then leaves the rest to its snapshots', async () => {
    host.unreachable = true

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, {}, 0)
    movedHereStays()
    host.unreachable = false
    host.tabs = [{ parentTabId: 'drawn-tab', leafId: REQUEST.leafId }]

    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(1))
    movedHereStays()
  })

  it('takes nothing from a host restarted on the same pairing: its list does not undo the move', async () => {
    // The lost reply is asked about after the host restarted; the new runtime does not hold the tab.
    host.runtimeId = 'runtime-2'
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, { onRefused }, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    movedHereStays()
    expect(store.transferAgentPaneAuthority).not.toHaveBeenCalled()
    expect(onRefused).not.toHaveBeenCalled()
    // The replacement host's snapshots reconcile the window instead.
    expect(refreshSnapshot).toHaveBeenCalledWith('env-1', REQUEST.worktreeId, {
      acceptCurrentSnapshot: true
    })
  })

  it('pins every call to the runtime and pairing that admitted the move', async () => {
    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, {}, 0)

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'session.tabs.list',
        expectedEnvironmentRuntimeId: 'runtime-1',
        expectedEnvironmentPairingRevision: 1
      })
    )
  })

  it.each([
    ['the host was re-paired', () => (pairing.revision = 2)],
    ['the worktree moved to another host', () => (host.routedEnvironmentId = 'env-2')]
  ])('applies nothing from a move when %s before it answered', async (_case, change) => {
    change()
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', true, { onRefused })

    movedHereStays()
    expect(store.transferAgentPaneAuthority).not.toHaveBeenCalled()
    expect(onRefused).not.toHaveBeenCalled()
  })

  it('applies nothing from an answer the admitted host never gave', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'superseded', true, { onRefused })

    movedHereStays()
    expect(onRefused).not.toHaveBeenCalled()
    expect(refreshSnapshot).toHaveBeenCalledTimes(1)
  })

  it('tells the user about a refusal even when this window could not draw the move', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', false, { onRefused })

    expect(onRefused).toHaveBeenCalledTimes(1)
    movedHereStays()
    expect(refreshSnapshot).toHaveBeenCalledTimes(1)
  })

  it('gives the pane back its focus after a refusal only if the user is still on it', async () => {
    store.activeTabId = 'drawn-tab'

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', true)

    const [tabId, leafId, options] = focusSurface.mock.calls[0]!
    expect([tabId, leafId]).toEqual(['source-tab', REQUEST.leafId])
    store.activeTabId = 'source-tab'
    expect(options.shouldFocus()).toBe(true)
    // The user opened Settings before the focus landed.
    store.activeView = 'settings'
    expect(options.shouldFocus()).toBe(false)
  })
})
