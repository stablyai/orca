// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock(
  '../../components/terminal-pane/pty-transport/legacy-relay/legacy-relay-bridge-panes',
  () => ({
    legacyRelayBridgedTabIds: (targetId: string) => (targetId === 'ssh-1' ? ['tab-1', 'tab-2'] : [])
  })
)

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  Reflect.deleteProperty(window, 'api')
})

describe('a host kept connected for the relay bridge', () => {
  it('never loads the bridge panes module, which subscribes on load, just by being imported', async () => {
    vi.resetModules()
    vi.doUnmock(
      '../../components/terminal-pane/pty-transport/legacy-relay/legacy-relay-bridge-panes'
    )
    const listPanes = vi.fn(() => undefined)
    Object.assign(window, { api: { ssh: {}, legacyRelayBridge: { listPanes, onPanes: vi.fn() } } })
    await import('./ssh-managed-server-state-effects')
    expect(listPanes).not.toHaveBeenCalled()
  })
})
