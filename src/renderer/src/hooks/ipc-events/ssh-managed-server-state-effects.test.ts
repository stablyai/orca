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
type ToastOptions = {
  action: { label: string; onClick: () => void }
  cancel: { label: string; onClick: () => void }
}

const offer: Status = {
  kind: 'relay',
  reason: 'relay_terminals_live',
  terminals: 3,
  offerMove: true
}
const moveToManagedServer = vi.fn()

function lastToastOptions(): ToastOptions {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the offer toast always passes options shaped like sonner's ExternalToast.
  return mocks.toast.mock.calls.at(-1)?.[1] as ToastOptions
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { api: { ssh: { moveToManagedServer } } })
})
afterEach(() => {
  Reflect.deleteProperty(window, 'api')
})

describe('the one-time move offer toast', () => {
  it('names the host and the terminals that will restart', () => {
    applySshManagedServerTransition('ssh-1', undefined, offer)
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast.mock.calls[0][0]).toBe(
      'Move Box to a managed Orca server for more reliable connections. Its 3 open terminals will restart.'
    )
    expect(lastToastOptions().action.label).toBe('Move')
    expect(lastToastOptions().cancel.label).toBe('Not now')
  })

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

  it('"Not now" only closes the toast; "Move" runs the move and reports it', async () => {
    applySshManagedServerTransition('ssh-1', undefined, offer)
    lastToastOptions().cancel.onClick()
    expect(moveToManagedServer).not.toHaveBeenCalled()

    moveToManagedServer.mockResolvedValueOnce({ outcome: 'moved', environmentId: 'env-1' })
    lastToastOptions().action.onClick()
    await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalled())
    expect(moveToManagedServer).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(mocks.toast.success).toHaveBeenCalledWith('Box now runs a managed Orca server.', {
      id: 'progress'
    })
  })

  it('reports a refusal from the move', async () => {
    applySshManagedServerTransition('ssh-1', undefined, offer)
    moveToManagedServer.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 1
    })
    lastToastOptions().action.onClick()
    await vi.waitFor(() => expect(mocks.toast.error).toHaveBeenCalled())
    expect(mocks.toast.error.mock.calls[0][0]).toContain('couldn’t confirm that 1 terminal on')
  })

  it('never states an unknown count as zero', async () => {
    applySshManagedServerTransition('ssh-1', undefined, offer)
    moveToManagedServer.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      terminals: 0
    })
    lastToastOptions().action.onClick()
    await vi.waitFor(() => expect(mocks.toast.error).toHaveBeenCalled())
    expect(mocks.toast.error.mock.calls[0][0]).toBe(
      'Not moved: Orca couldn’t confirm that the terminals on Box stopped.'
    )
  })
})
