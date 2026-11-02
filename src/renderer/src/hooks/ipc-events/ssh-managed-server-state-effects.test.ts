// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../../shared/ssh-types'

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(() => 'progress'),
    dismiss: vi.fn()
  }),
  fetchReposForAllHosts: vi.fn(async () => undefined),
  remountTerminalTabForRecovery: vi.fn()
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      fetchReposForAllHosts: mocks.fetchReposForAllHosts,
      remountTerminalTabForRecovery: mocks.remountTerminalTabForRecovery,
      sshTargetLabels: new Map([['ssh-1', 'Box']]),
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })
  }
}))

vi.mock('../../components/terminal-pane/legacy-relay-bridge-panes', () => ({
  legacyRelayBridgedTabIds: (targetId: string) => (targetId === 'ssh-1' ? ['tab-1', 'tab-2'] : [])
}))

const { applySshManagedServerTransition } = await import('./ssh-managed-server-state-effects')

type Status = SshConnectionState['managedServer']

const offer: Status = {
  kind: 'relay',
  reason: 'relay_terminals_live',
  terminals: 3
}
const moveToManagedServer = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { api: { ssh: { moveToManagedServer } } })
})
afterEach(() => {
  Reflect.deleteProperty(window, 'api')
})

describe('a host kept connected for the relay bridge', () => {
  const bridged: Status = {
    kind: 'relay',
    reason: 'relay_terminals_live',
    terminals: 1,
    bridged: true
  }

  it('remounts the relay-era tabs the bridge serves once, so they reattach (STA-10604)', async () => {
    applySshManagedServerTransition('ssh-1', { kind: 'setting-up', phase: 'converting' }, bridged)
    await vi.waitFor(() =>
      expect(mocks.remountTerminalTabForRecovery.mock.calls).toEqual([['tab-1'], ['tab-2']])
    )
    mocks.remountTerminalTabForRecovery.mockClear()
    applySshManagedServerTransition('ssh-1', bridged, bridged)
    applySshManagedServerTransition('ssh-1', undefined, offer)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it('still remounts when the connect reply stored the bridged status before its push', async () => {
    applySshManagedServerTransition('ssh-1', undefined, offer)
    mocks.remountTerminalTabForRecovery.mockClear()
    applySshManagedServerTransition('ssh-1', bridged, bridged)
    await vi.waitFor(() =>
      expect(mocks.remountTerminalTabForRecovery.mock.calls).toEqual([['tab-1'], ['tab-2']])
    )
  })

  it('never loads the bridge panes module, which subscribes on load, just by being imported', async () => {
    vi.resetModules()
    vi.doUnmock('../../components/terminal-pane/legacy-relay-bridge-panes')
    const listPanes = vi.fn(() => undefined)
    Object.assign(window, { api: { ssh: {}, legacyRelayBridge: { listPanes, onPanes: vi.fn() } } })
    await import('./ssh-managed-server-state-effects')
    expect(listPanes).not.toHaveBeenCalled()
  })
})

describe('a host the managed server does not serve', () => {
  it('shows only for a newly marked offer, never for a plain live-terminals status', () => {
    applySshManagedServerTransition('ssh-1', offer, offer)
    applySshManagedServerTransition('ssh-1', undefined, {
      kind: 'relay',
      reason: 'relay_terminals_live',
      terminals: 3
    })
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('stays silent where the move is not available', () => {
    Object.assign(window, { api: { ssh: {} } })
    applySshManagedServerTransition('ssh-1', undefined, offer)
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
