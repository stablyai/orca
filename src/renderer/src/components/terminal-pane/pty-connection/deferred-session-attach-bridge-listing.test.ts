import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyRelayBridgedPane } from '../../../../../shared/legacy-relay-bridge-contract'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const mocks = vi.hoisted(() => {
  const held: { listing: ((panes: LegacyRelayBridgedPane[]) => void) | null } = { listing: null }
  return Object.assign(held, { remount: vi.fn(), choice: vi.fn() })
})

vi.stubGlobal('window', {
  api: {
    legacyRelayBridge: {
      // Main's first pane list arrives only when a test releases it.
      listPanes: () =>
        new Promise<LegacyRelayBridgedPane[]>((resolve) => {
          mocks.listing = resolve
        }),
      onPanes: () => () => {}
    }
  }
})
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ remountTerminalTabForRecovery: mocks.remount }) }
}))
vi.mock('./reattach/deferred-session-reattach-choice', () => ({
  runDeferredSessionReattachChoice: mocks.choice
}))
vi.mock('./reattach/deferred-session-reattach-connect', () => ({
  startDeferredSessionReattach: vi.fn()
}))
vi.mock('./host-ownership/unserved-ssh-pane-connect', () => ({
  connectUnservedSshPaneTarget: vi.fn()
}))

const bridged: LegacyRelayBridgedPane = {
  ptyId: 'ssh:ssh-box@@pty-1',
  targetId: 'ssh-box',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  state: 'unverifiable'
}

function runtimePane(): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach choice reads only these fields.
  return {
    runtimeEnvironmentId: 'env-1',
    legacyRelayBridgePtyId: null,
    unservedSshTargetId: null,
    pendingReplacedPtyId: null,
    disposed: false,
    deps: { tabId: 'web-terminal-tab-1', restoredLeafId: 'leaf-1' },
    pane: { leafId: 'leaf-1' }
  } as unknown as ConnectPanePtySession
}

async function freshModules() {
  vi.resetModules()
  mocks.listing = null
  return import('./deferred-session-attach')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a runtime pane that mounts before the bridged-pane list (#37840)', () => {
  it('waits for the list and remounts onto the bridge instead of starting on the server', async () => {
    const { runDeferredSessionAttach } = await freshModules()

    runDeferredSessionAttach(runtimePane())
    expect(mocks.choice).not.toHaveBeenCalled()

    mocks.listing?.([bridged])
    await vi.waitFor(() => expect(mocks.remount).toHaveBeenCalledWith('web-terminal-tab-1'))
    expect(mocks.choice).not.toHaveBeenCalled()
  })

  it('starts as before once the list names no relay terminal for it', async () => {
    const { runDeferredSessionAttach } = await freshModules()

    runDeferredSessionAttach(runtimePane())
    mocks.listing?.([])

    await vi.waitFor(() => expect(mocks.choice).toHaveBeenCalledTimes(1))
    expect(mocks.remount).not.toHaveBeenCalled()
  })

  it('does not wait once the list has arrived', async () => {
    const { runDeferredSessionAttach } = await freshModules()
    const { legacyRelayBridgedPanesListed } =
      await import('../pty-transport/legacy-relay/legacy-relay-bridge-panes')
    mocks.listing?.([])
    await legacyRelayBridgedPanesListed()

    runDeferredSessionAttach(runtimePane())

    expect(mocks.choice).toHaveBeenCalledTimes(1)
  })
})
