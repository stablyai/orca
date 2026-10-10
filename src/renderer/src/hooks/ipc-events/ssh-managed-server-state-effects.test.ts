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
  fetchReposForAllHosts: vi.fn(async () => undefined)
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      fetchReposForAllHosts: mocks.fetchReposForAllHosts,
      sshTargetLabels: new Map([['ssh-1', 'Box']]),
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })
  }
}))

const { applySshManagedServerTransition } = await import('./ssh-managed-server-state-effects')

type Status = SshConnectionState['managedServer']

const offer: Status = {
  kind: 'relay',
  reason: 'relay_terminals_live',
  terminals: 3,
  offerMove: true
}
const moveToManagedServer = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { api: { ssh: { moveToManagedServer } } })
})
afterEach(() => {
  Reflect.deleteProperty(window, 'api')
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
