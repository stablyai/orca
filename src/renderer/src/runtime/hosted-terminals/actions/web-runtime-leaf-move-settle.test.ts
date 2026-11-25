import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  activeTabId: null,
  transferAgentPaneAuthority: vi.fn(),
  closeTab: vi.fn()
}))
const refreshSnapshot = vi.hoisted(() => vi.fn(async () => {}))
const hostTabs = vi.hoisted(
  (): { tabs: { parentTabId: string; leafId: string }[]; unreachable: boolean } => ({
    tabs: [],
    unreachable: false
  })
)
const pairing = vi.hoisted(() => ({ revision: 1 }))

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: refreshSnapshot
}))
vi.mock('../../web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => true,
  captureRuntimeEnvironmentCall: () => async () => {
    if (hostTabs.unreachable) {
      throw new Error('no route to host')
    }
    return { ok: true, result: { tabs: hostTabs.tabs } }
  }
}))
vi.mock('../../rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => pairing.revision
}))

const { settleHostPaneMove } = await import('./web-runtime-leaf-move')

const REQUEST = {
  worktreeId: 'repo::/wt',
  sourceTabId: 'source-tab',
  targetTabId: 'drawn-tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'pty-1'
}

const AUTHORITY = { environmentId: 'env-1', pairingRevision: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  hostTabs.tabs = []
  hostTabs.unreachable = false
  pairing.revision = 1
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

  it('keeps a move the host committed and only then lets the tab be named', async () => {
    const onRefused = vi.fn()
    const onCommitted = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'moved', true, { onRefused, onCommitted })

    expect(store.closeTab).not.toHaveBeenCalled()
    expect(onRefused).not.toHaveBeenCalled()
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })

  it('undoes a move whose reply was lost and the host does not hold, without a failure message', async () => {
    const onRefused = vi.fn()
    const onCommitted = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, { onRefused, onCommitted }, 0)
    // Let the one later check run (the host still does not hold it).
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(store.closeTab).toHaveBeenCalledTimes(1)
    expect(onRefused).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
  })

  it('draws and names a lost-reply move the host commits after saying it did not hold it', async () => {
    const onCommitted = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, { onCommitted }, 0)
    hostTabs.tabs = [{ parentTabId: 'drawn-tab', leafId: REQUEST.leafId }]

    await vi.waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1))
    expect(refreshSnapshot).toHaveBeenCalledTimes(2)
  })

  it('asks a host it could not reach once more, then leaves the rest to its snapshots', async () => {
    hostTabs.unreachable = true
    const onCommitted = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, { onCommitted }, 0)
    expect(store.closeTab).not.toHaveBeenCalled()
    hostTabs.unreachable = false
    hostTabs.tabs = [{ parentTabId: 'drawn-tab', leafId: REQUEST.leafId }]

    await vi.waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1))
  })

  it('applies nothing from a move whose host was re-paired before it answered', async () => {
    pairing.revision = 2
    const onRefused = vi.fn()
    const onCommitted = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', true, { onRefused, onCommitted })

    expect(store.closeTab).not.toHaveBeenCalled()
    expect(store.transferAgentPaneAuthority).not.toHaveBeenCalled()
    expect(onRefused).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
    expect(refreshSnapshot).toHaveBeenCalledWith('env-1', REQUEST.worktreeId, {
      acceptCurrentSnapshot: true
    })
  })

  it('keeps a move whose reply was lost when the host holds the pane in the new tab', async () => {
    hostTabs.tabs = [{ parentTabId: 'drawn-tab', leafId: REQUEST.leafId }]
    const onCommitted = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'unknown', true, { onCommitted })

    expect(store.closeTab).not.toHaveBeenCalled()
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })

  it('tells the user about a refusal even when this window could not draw the move', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', false, { onRefused })

    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(store.closeTab).not.toHaveBeenCalled()
    expect(refreshSnapshot).toHaveBeenCalledTimes(1)
  })
})
