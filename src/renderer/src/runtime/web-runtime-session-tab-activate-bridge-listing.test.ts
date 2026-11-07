import { describe, expect, it, vi } from 'vitest'
import type { LegacyRelayBridgedPane } from '../../../shared/legacy-relay-bridge-contract'

const mocks = vi.hoisted(() => {
  const held: { listing: ((panes: LegacyRelayBridgedPane[]) => void) | null } = { listing: null }
  return Object.assign(held, { isWebRuntimeSessionActive: vi.fn(() => false) })
})

vi.stubGlobal('window', {
  api: {
    legacyRelayBridge: {
      // Main's first pane list arrives only when the test releases it.
      listPanes: () =>
        new Promise<LegacyRelayBridgedPane[]>((resolve) => {
          mocks.listing = resolve
        }),
      onPanes: () => () => {}
    }
  }
})
vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({
      terminalLayoutsByTabId: { 'web-terminal-tab-1': { activeLeafId: 'leaf-1' } },
      settings: { activeRuntimeEnvironmentId: 'env-1' }
    })
  }
}))
vi.mock('./web-runtime-session-environment', () => ({
  captureRuntimeEnvironmentCall: vi.fn(),
  captureWebSessionIntentOwner: (environmentId: string) => ({ environmentId }),
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  matchesWebSessionIntentOwner: () => true
}))

const { activateWebRuntimeSessionTab } = await import('./web-runtime-session-tab-lifecycle')

describe('activating a tab before the bridged-pane list arrives (#37840)', () => {
  it('leaves a pane the older relay runs alone instead of starting it on the server', async () => {
    const activation = activateWebRuntimeSessionTab({
      worktreeId: 'wt-1',
      tabId: 'web-terminal-tab-1',
      environmentId: 'env-1'
    })
    await vi.waitFor(() => expect(mocks.listing).not.toBeNull())
    mocks.listing?.([
      {
        ptyId: 'ssh:ssh-box@@pty-1',
        targetId: 'ssh-box',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        state: 'unverifiable'
      }
    ])

    await expect(activation).resolves.toBe(true)
    expect(mocks.isWebRuntimeSessionActive).not.toHaveBeenCalled()
  })
})
