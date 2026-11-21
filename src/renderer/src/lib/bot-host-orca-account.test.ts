// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaAccountServerStatus } from '../../../shared/orca-account-server-sign-in'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

import {
  refreshBotHostOrcaAccount,
  startBotHostSignIn,
  useBotHostOrcaAccount
} from './bot-host-orca-account'
import { emitBotsChangedWindowEvent } from './bots-changed-window-event'

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

const HOST = 'runtime:env-shared-read' as ExecutionHostId

const SIGNED_IN: OrcaAccountServerStatus = {
  state: 'signed-in',
  email: 'ada@example.com',
  storage: { kind: 'os-keychain' }
}

function statusCalls(): unknown[][] {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'orcaAccount.status')
}

describe('useBotHostOrcaAccount', () => {
  it('shares one read across cards that mount at different times', async () => {
    let release!: (status: OrcaAccountServerStatus) => void
    const pending = new Promise<OrcaAccountServerStatus>((resolve) => {
      release = resolve
    })
    mocks.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'orcaAccount.status') {
        return pending
      }
      throw new Error(`unexpected ${method}`)
    })

    const first = renderHook(() => useBotHostOrcaAccount(HOST))
    const second = renderHook(() => useBotHostOrcaAccount(HOST))
    expect(statusCalls()).toHaveLength(1)

    await act(async () => {
      release(SIGNED_IN)
      await pending
    })
    await waitFor(() => expect(first.result.current?.email).toBe('ada@example.com'))
    expect(second.result.current?.email).toBe('ada@example.com')

    const later = renderHook(() => useBotHostOrcaAccount(HOST))
    expect(statusCalls()).toHaveLength(1)
    expect(later.result.current?.email).toBe('ada@example.com')

    emitBotsChangedWindowEvent(HOST)
    expect(statusCalls()).toHaveLength(2)

    first.unmount()
    second.unmount()
    later.unmount()
  })
})
