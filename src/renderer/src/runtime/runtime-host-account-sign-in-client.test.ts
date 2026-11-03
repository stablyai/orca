import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAccountSignInStatus } from '../../../shared/host-account-sign-in-types'
import '@/i18n/i18n'
import '@/i18n/locales/es.json'

type RecordedCall = { method: string; params: unknown; revision: number | undefined }
const rpc = vi.hoisted(() => {
  const calls: RecordedCall[] = []
  return {
    calls,
    capability: Promise.resolve(),
    answer: (_method: string, _params: unknown): unknown => null
  }
})

vi.mock('./runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: vi.fn(() => rpc.capability),
  callRuntimeRpc: vi.fn(
    async (
      _target: unknown,
      method: string,
      params: unknown,
      options: { expectedEnvironmentPairingRevision?: number }
    ) => {
      rpc.calls.push({ method, params, revision: options.expectedEnvironmentPairingRevision })
      return rpc.answer(method, params)
    }
  )
}))
vi.mock('./runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => 7
}))

import {
  addCodexAccountOnHost,
  cancelHostAccountSignIn,
  runningHostAccountSignInOwner
} from './runtime-host-account-sign-in-client'

const OWNER = { kind: 'environment', environmentId: 'server' } as const
const CODEX = { accounts: [], activeAccountId: null }

function status(patch: Partial<HostAccountSignInStatus>): HostAccountSignInStatus {
  return { flowId: 'flow-1', provider: 'codex', revision: 1, phase: 'starting', ...patch }
}

beforeEach(() => {
  rpc.calls.length = 0
  rpc.capability = Promise.resolve()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('host account sign-in client', () => {
  it('starts nothing on the host when Cancel lands during the capability check', async () => {
    const capability = Promise.withResolvers<void>()
    rpc.capability = capability.promise
    const adding = addCodexAccountOnHost(OWNER)
    await expect(cancelHostAccountSignIn(OWNER, 'codex')).resolves.toBe(true)
    capability.resolve()
    await expect(adding).rejects.toThrow('Codex sign-in was cancelled.')
    expect(rpc.calls).toEqual([])
  })

  it('applies a Cancel clicked before the host answered the start', async () => {
    const start = Promise.withResolvers<HostAccountSignInStatus>()
    rpc.answer = (method) =>
      method === 'accounts.hostSignInStart'
        ? start.promise
        : status({ revision: 2, phase: 'cancelled' })
    const adding = addCodexAccountOnHost(OWNER)
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1))
    await expect(cancelHostAccountSignIn(OWNER, 'codex')).resolves.toBe(true)
    start.resolve(status({}))
    await expect(adding).rejects.toThrow('Codex sign-in was cancelled.')
    expect(rpc.calls.map((call) => call.method)).toContain('accounts.hostSignInCancel')
  })

  it('names the server a sign-in runs on, so Cancel reaches it after the picker moves', async () => {
    const start = Promise.withResolvers<HostAccountSignInStatus>()
    rpc.answer = (method) =>
      method === 'accounts.hostSignInStart'
        ? start.promise
        : status({ revision: 2, phase: 'signedIn', codex: CODEX })
    expect(runningHostAccountSignInOwner('codex')).toBeNull()
    const adding = addCodexAccountOnHost(OWNER)
    expect(runningHostAccountSignInOwner('codex')).toEqual(OWNER)
    expect(runningHostAccountSignInOwner('claude')).toBeNull()
    // A second server for the same provider would make Cancel ambiguous, so it is refused.
    await expect(
      addCodexAccountOnHost({ kind: 'environment', environmentId: 'other' })
    ).rejects.toThrow('still running on another server')
    start.resolve(status({}))
    await adding
    expect(runningHostAccountSignInOwner('codex')).toBeNull()
  })

  it('joins the running sign-in when Add is clicked again', async () => {
    const start = Promise.withResolvers<HostAccountSignInStatus>()
    rpc.answer = (method) =>
      method === 'accounts.hostSignInStart'
        ? start.promise
        : status({ revision: 2, phase: 'signedIn', codex: CODEX })
    const first = addCodexAccountOnHost(OWNER)
    const second = addCodexAccountOnHost(OWNER)
    start.resolve(status({}))
    await expect(Promise.all([first, second])).resolves.toEqual([CODEX, CODEX])
    expect(rpc.calls.filter((call) => call.method === 'accounts.hostSignInStart')).toHaveLength(1)
  })
})
