// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaAccountServerStatus } from '../../../shared/orca-account-server-sign-in'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

import { refreshBotHostOrcaAccount, startBotHostSignIn } from './bot-host-orca-account'

afterEach(() => {
  mocks.callRuntimeRpc.mockReset()
})

function account(state: OrcaAccountServerStatus['state']): OrcaAccountServerStatus {
  return {
    state,
    email: state === 'signed-out' ? undefined : 'ada@example.com',
    storage: { kind: 'os-keychain' }
  }
}

async function startAfter(hostId: ExecutionHostId, state: OrcaAccountServerStatus['state']) {
  mocks.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'orcaAccount.status') {
      return account(state)
    }
    if (method === 'orcaAccount.signIn.start') {
      return {
        flowId: 'flow-1',
        provider: 'sign-in',
        revision: 1,
        phase: 'failed',
        error: 'stopped'
      }
    }
    throw new Error(`unexpected ${method}`)
  })
  await refreshBotHostOrcaAccount(hostId)
  mocks.callRuntimeRpc.mockClear()
  await startBotHostSignIn(hostId)
  const start = mocks.callRuntimeRpc.mock.calls.find(
    (call) => call[1] === 'orcaAccount.signIn.start'
  )
  return start?.[2]
}

describe('startBotHostSignIn', () => {
  it('replaces an account that is still signed in locally', async () => {
    await expect(startAfter('runtime:env-still-signed-in', 'signed-in')).resolves.toEqual({
      approveInBrowser: true,
      switchAccount: true
    })
  })

  it('starts a plain sign-in when the host is no longer signed in', async () => {
    await expect(startAfter('runtime:env-reconnect', 'reconnect-required')).resolves.toEqual({
      approveInBrowser: true,
      switchAccount: false
    })
  })
})
