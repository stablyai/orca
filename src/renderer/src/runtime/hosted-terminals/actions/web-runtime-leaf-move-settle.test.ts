import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  activeTabId: null,
  transferAgentPaneAuthority: vi.fn(),
  closeTab: vi.fn()
}))
const refreshSnapshot = vi.hoisted(() => vi.fn(async () => {}))
const hostTabs = vi.hoisted((): { tabs: { parentTabId: string; leafId: string }[] } => ({
  tabs: []
}))

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: refreshSnapshot
}))
vi.mock('../../web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => true,
  captureRuntimeEnvironmentCall: () => async () => ({ ok: true, result: hostTabs })
}))

const { settleHostPaneMove } = await import('./web-runtime-leaf-move')

const REQUEST = {
  worktreeId: 'repo::/wt',
  sourceTabId: 'source-tab',
  targetTabId: 'drawn-tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'pty-1'
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('settling a pane move with its host', () => {
  it('undoes a refused move without stopping its terminal, then tells the user', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove('env-1', REQUEST, 'refused', true, { onRefused })

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

    await settleHostPaneMove('env-1', REQUEST, 'moved', true, { onRefused, onCommitted })

    expect(store.closeTab).not.toHaveBeenCalled()
    expect(onRefused).not.toHaveBeenCalled()
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })

  it('undoes a move whose reply was lost and the host does not hold, without a failure message', async () => {
    hostTabs.tabs = []
    const onRefused = vi.fn()
    const onCommitted = vi.fn()

    await settleHostPaneMove('env-1', REQUEST, 'unknown', true, { onRefused, onCommitted })

    expect(store.closeTab).toHaveBeenCalledTimes(1)
    expect(onRefused).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
  })

  it('keeps a move whose reply was lost when the host holds the pane in the new tab', async () => {
    hostTabs.tabs = [{ parentTabId: 'drawn-tab', leafId: REQUEST.leafId }]
    const onCommitted = vi.fn()

    await settleHostPaneMove('env-1', REQUEST, 'unknown', true, { onCommitted })

    expect(store.closeTab).not.toHaveBeenCalled()
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })

  it('tells the user about a refusal even when this window could not draw the move', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove('env-1', REQUEST, 'refused', false, { onRefused })

    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(store.closeTab).not.toHaveBeenCalled()
    expect(refreshSnapshot).toHaveBeenCalledTimes(1)
  })
})
