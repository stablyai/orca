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
  cancelHostAccountSignIn
} from './runtime-host-account-sign-in-client'

const OWNER = { kind: 'environment', environmentId: 'server' } as const

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
})
