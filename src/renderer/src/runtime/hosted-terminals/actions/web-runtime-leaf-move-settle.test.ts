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
const refreshSnapshot = vi.hoisted(() =>
  vi.fn(async (_env: string, _worktreeId: string, _options: { isCurrent?: () => boolean }) => {})
)
const focusSurface = vi.hoisted(() => vi.fn())
const capabilityProof = vi.hoisted(() => vi.fn())
/** The paired host as main's transport reaches it. */
type HostState = {
  runtimeId: string
  pairingRevision: number
  /** What `session.tabs.list` answers, as the host builds it. */
  inventory: { publicationEpoch: string; tabs: { parentTabId: string; leafId: string }[] }
  moveAnswer: { status: 'moved' } | { status: 'refused'; reason: string }
  unreachable: boolean
  routedEnvironmentId: string | null
}
const host = vi.hoisted(() => {
  const state: HostState = {
    runtimeId: 'runtime-1',
    pairingRevision: 1,
    inventory: { publicationEpoch: 'epoch-1', tabs: [] },
    moveAnswer: { status: 'moved' },
    unreachable: false,
    routedEnvironmentId: 'env-1'
  }
  return state
})

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: refreshSnapshot
}))
vi.mock('../../rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => host.pairingRevision
}))
vi.mock('../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentCapabilityProof: capabilityProof
}))
vi.mock('../../web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => true
}))
vi.mock('../../../lib/workspace/ownership/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => host.routedEnvironmentId
}))
vi.mock('../../../components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusSurface
}))

const { moveWebRuntimeLeafToNewTab, resolvePaneMoveHost, settleHostPaneMove } =
  await import('./web-runtime-leaf-move')
const { acceptSessionTabsRuntimeId } =
  await import('../../web-session-tabs-sync/tracking/publisher-identity-fences')
const { sessionTabsRuntimeHistoryByEnvironment } = await import('../../web-session-tabs-sync/state')

const WT = 'repo::/wt'
const REQUEST = {
  worktreeId: WT,
  sourceTabId: 'source-tab',
  targetTabId: 'drawn-tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'pty-1'
}
const AUTHORITY = {
  environmentId: 'env-1',
  pairingRevision: 1,
  runtimeId: 'runtime-1',
  worktreeId: WT
}
const HOLDS_MOVED_PANE = [{ parentTabId: 'drawn-tab', leafId: REQUEST.leafId }]

/**
 * main's `runtimeEnvironments:call` as it behaves: an expectation it is given and that no longer
 * matches is refused before sending (an absent one is not checked); every answer carries the
 * runtime that gave it.
 */
const call = vi.fn(
  async (args: {
    method: string
    expectedEnvironmentRuntimeId?: string
    expectedEnvironmentPairingRevision?: number
  }) => {
    const meta = { runtimeId: host.runtimeId }
    if (
      (args.expectedEnvironmentRuntimeId !== undefined &&
        args.expectedEnvironmentRuntimeId !== host.runtimeId) ||
      (args.expectedEnvironmentPairingRevision !== undefined &&
        args.expectedEnvironmentPairingRevision !== host.pairingRevision)
    ) {
      return {
        id: args.method,
        ok: false,
        error: { code: 'runtime_environment_changed', message: 'changed' },
        _meta: meta
      }
    }
    if (host.unreachable) {
      return {
        id: args.method,
        ok: false,
        error: { code: 'runtime_unavailable', message: 'no route to host' },
        _meta: meta
      }
    }
    const result =
      args.method === 'session.tabs.list'
        ? { worktree: WT, snapshotVersion: 3, activeGroupId: null, ...host.inventory }
        : host.moveAnswer
    return { id: args.method, ok: true, result, _meta: meta }
  }
)

const PLACEMENT = { targetGroupId: 'group-1' }

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(host, {
    runtimeId: 'runtime-1',
    pairingRevision: 1,
    inventory: { publicationEpoch: 'epoch-1', tabs: [] },
    moveAnswer: { status: 'moved' },
    unreachable: false,
    routedEnvironmentId: 'env-1'
  })
  sessionTabsRuntimeHistoryByEnvironment.clear()
  acceptSessionTabsRuntimeId('env-1', 'runtime-1')
  store.activeView = 'terminal'
  store.activeTabId = null
  Object.assign(window, { api: { runtimeEnvironments: { call } } })
})

const movedHereStays = () => {
  expect(store.closeTab).not.toHaveBeenCalled()
  expect(store.transferAgentPaneAuthority).not.toHaveBeenCalled()
}

describe('admitting a pane move on its host', () => {
  it('admits the runtime that proved the capability', async () => {
    capabilityProof.mockResolvedValueOnce({
      supported: true,
      runtimeId: 'runtime-1',
      pairingRevision: 1
    })

    expect(await resolvePaneMoveHost(WT)).toEqual({ kind: 'host', authority: AUTHORITY })
  })

  it('does not admit a runtime this window has already seen replaced', async () => {
    acceptSessionTabsRuntimeId('env-1', 'runtime-2')
    capabilityProof.mockResolvedValueOnce({
      supported: true,
      runtimeId: 'runtime-1',
      pairingRevision: 1
    })

    expect(await resolvePaneMoveHost(WT)).toEqual({ kind: 'unavailable' })
  })
})

describe('sending a pane move to its host', () => {
  it.each([
    ['the admitted host moved it', () => {}, 'moved'],
    [
      'the admitted host refused it',
      () => (host.moveAnswer = { status: 'refused', reason: 'pane_unavailable' }),
      'refused'
    ],
    ['the host restarted before it was sent', () => (host.runtimeId = 'runtime-2'), 'superseded'],
    ['the host was re-paired before it was sent', () => (host.pairingRevision = 2), 'superseded'],
    ['the reply was lost', () => (host.unreachable = true), 'unknown']
  ])('answers when %s', async (_case, arrange, outcome) => {
    arrange()

    expect(await moveWebRuntimeLeafToNewTab(AUTHORITY, REQUEST, PLACEMENT)).toBe(outcome)
  })
})

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

  it('undoes a lost-reply move only on the published inventory saying the host lacks it', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, { onRefused }, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(store.closeTab).toHaveBeenCalledTimes(1)
    expect(onRefused).not.toHaveBeenCalled()
  })

  it('keeps a lost-reply move when the host lists the pane in the new tab', async () => {
    host.inventory.tabs = HOLDS_MOVED_PANE

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, {}, 0)

    movedHereStays()
  })

  it('keeps a lost-reply move when the host has published nothing yet for the worktree', async () => {
    // A host that has not published this worktree lists it empty without attesting anything.
    host.inventory = { publicationEpoch: 'none', tabs: [] }

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, {}, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    movedHereStays()
  })

  it('redraws a lost-reply move the host commits after saying it did not hold it', async () => {
    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, {}, 0)
    host.inventory.tabs = HOLDS_MOVED_PANE

    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(2))
  })

  it('asks a host it could not reach once more, then leaves the rest to its snapshots', async () => {
    host.unreachable = true

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, {}, 0)
    movedHereStays()
    host.unreachable = false
    host.inventory.tabs = HOLDS_MOVED_PANE

    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(1))
    movedHereStays()
  })

  it('takes nothing from a host restarted on the same pairing: its list does not undo the move', async () => {
    host.runtimeId = 'runtime-2'
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, { onRefused }, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    movedHereStays()
    expect(onRefused).not.toHaveBeenCalled()
  })

  it.each([
    ['the host was re-paired', () => (host.pairingRevision = 2)],
    ['the worktree moved to another host', () => (host.routedEnvironmentId = 'env-2')],
    [
      'this window saw the host restart on the same pairing',
      () => acceptSessionTabsRuntimeId('env-1', 'runtime-2')
    ]
  ])('applies nothing from a refusal when %s before it was settled', async (_case, change) => {
    change()
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', true, { onRefused })

    movedHereStays()
    expect(onRefused).not.toHaveBeenCalled()
  })

  it('reconciles only with the host the worktree routes to, and only while it still does', async () => {
    host.routedEnvironmentId = 'env-2'

    await settleHostPaneMove(AUTHORITY, REQUEST, 'superseded', true)

    const [environmentId, worktreeId, options] = refreshSnapshot.mock.calls[0]!
    expect([environmentId, worktreeId]).toEqual(['env-2', WT])
    expect(options.isCurrent?.()).toBe(true)
    // Rerouted again while that refresh was in flight: its frame must not apply.
    host.routedEnvironmentId = 'env-3'
    expect(options.isCurrent?.()).toBe(false)
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
    store.activeView = 'settings'
    expect(options.shouldFocus()).toBe(false)
  })

  it('does not refocus after a refusal once the host was seen restarting during the refresh', async () => {
    store.activeTabId = 'drawn-tab'
    refreshSnapshot.mockImplementationOnce(async () => {
      store.activeTabId = 'source-tab'
      acceptSessionTabsRuntimeId('env-1', 'runtime-2')
    })

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', true)

    const [, , options] = focusSurface.mock.calls[0]!
    expect(options.shouldFocus()).toBe(false)
  })
})
