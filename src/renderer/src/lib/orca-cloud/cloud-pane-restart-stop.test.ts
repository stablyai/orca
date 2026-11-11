import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { method: string; params: unknown; environmentId: string }[] = []
let showPtyId: string | null = 'host-pty-7'
let stopResult: Record<string, unknown> = {}

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (target: { environmentId: string }, method: string, params: unknown) => {
    calls.push({ method, params, environmentId: target.environmentId })
    return method === 'terminal.show' ? { terminal: { ptyId: showPtyId } } : stopResult
  }
}))

const { stopRemotePaneTerminalForRestart } = await import('./cloud-pane-restart-stop')

describe('stopRemotePaneTerminalForRestart (RA-11 paired pane)', () => {
  beforeEach(() => {
    calls.length = 0
    showPtyId = 'host-pty-7'
    stopResult = { stoppedPtyIds: ['host-pty-7'], postStopVerified: true }
  })

  it('puts exactly that one host terminal to sleep (reversible, target only), never a close', async () => {
    await stopRemotePaneTerminalForRestart('remote:env-1@@term_a', 'wt-1')
    expect(calls.map((c) => c.method)).toEqual(['terminal.show', 'terminal.stopExact'])
    expect(calls[0]).toMatchObject({ environmentId: 'env-1', params: { terminal: 'term_a' } })
    expect(calls[1]).toMatchObject({
      environmentId: 'env-1',
      params: { expectedPtyIds: ['host-pty-7'], keepHistory: true, targetOnly: true }
    })
  })

  it('throws when the host has no live terminal for the pane, or does not confirm the stop', async () => {
    showPtyId = null
    await expect(stopRemotePaneTerminalForRestart('remote:env-1@@term_a', 'wt-1')).rejects.toThrow(
      'restart_remote_pane_not_live'
    )
    showPtyId = 'host-pty-7'
    stopResult = { stoppedPtyIds: ['host-pty-7'], postStopVerified: false }
    await expect(stopRemotePaneTerminalForRestart('remote:env-1@@term_a', 'wt-1')).rejects.toThrow()
  })

  it('refuses a pane id without an owning environment', async () => {
    await expect(stopRemotePaneTerminalForRestart('remote:term_a', 'wt-1')).rejects.toThrow(
      'restart_remote_pane_unowned'
    )
    expect(calls).toEqual([])
  })
})
