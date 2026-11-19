import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  transferAgentPaneAuthority: vi.fn(),
  closeTab: vi.fn()
}))
const refreshSnapshot = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: refreshSnapshot
}))

const { settleHostPaneMove } = await import('./web-runtime-leaf-move')

const REQUEST = {
  worktreeId: 'repo::/wt',
  sourceTabId: 'source-tab',
  targetTabId: 'drawn-tab',
  leafId: 'leaf-1',
  ptyId: 'pty-1'
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('settling a pane move with its host', () => {
  it('undoes a refused move without stopping its terminal, then tells the user', async () => {
    const onRefused = vi.fn()

    await settleHostPaneMove('env-1', REQUEST, 'refused', true, onRefused)

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

    await settleHostPaneMove('env-1', REQUEST, 'moved', true, onRefused)

    expect(store.closeTab).not.toHaveBeenCalled()
    expect(onRefused).not.toHaveBeenCalled()
  })
})
