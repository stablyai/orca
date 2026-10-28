import { afterEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
const toastWarning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, warning: toastWarning } }))
const storeState = vi.hoisted(() => ({ sshConnectionStates: new Map<string, unknown>() }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => storeState } }))

const { toastSshHostMoveRefused } = await import('./ssh-managed-server-refusal-toast')
const { toastSshConnectFailure } = await import('@/ssh/ssh-connect-failure-toast')

const refused = {
  kind: 'relay' as const,
  reason: 'refused' as const,
  canLeaveBehind: true as const,
  detail: 'This SSH host cannot move yet: automations (1), automation runs (4).'
}

afterEach(() => {
  toastError.mockClear()
  toastWarning.mockClear()
  vi.unstubAllGlobals()
})

describe('toastSshHostMoveRefused', () => {
  it('offers Move anyway and says what stays behind (#29083)', () => {
    toastSshHostMoveRefused('ssh-1', refused)
    expect(toastWarning).toHaveBeenCalledWith(
      expect.stringContaining(
        'automations (1), automation runs (4). Move anyway connects the host'
      ),
      {
        id: 'ssh-host-move-refused:ssh-1',
        duration: Number.POSITIVE_INFINITY,
        action: expect.objectContaining({ label: 'Move anyway…' })
      }
    )
  })

  it('offers no Move anyway on a web client, which can’t run it', () => {
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    toastSshHostMoveRefused('ssh-1', refused)
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining('SSH Hosts in Settings shows why')
    )
  })

  it('keeps one toast, with Move anyway, when the rejected connect toasts too', () => {
    storeState.sshConnectionStates = new Map([['ssh-1', { managedServer: refused }]])
    toastSshConnectFailure('ssh-1', new Error('This SSH host cannot move yet'), 'Connection failed')
    expect(toastWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'ssh-host-move-refused:ssh-1' })
    )
  })
})
