import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAccountSignInStatus } from '../../../shared/host-account-sign-in-types'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'

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
  HOST_SIGN_IN_RETRY_WINDOW_MS,
  addCodexAccountOnHost,
  cancelHostAccountSignIn,
  hostAccountSignInFailureText,
  retryLostAnswers,
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

const timedOut = (): Error => Object.assign(new Error('Request timed out'), { code: 'rpc_timeout' })

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

  it('asks the host again after a Cancel it could not deliver', async () => {
    let cancels = 0
    let waits = 0
    rpc.answer = (method) => {
      if (method === 'accounts.hostSignInStart') {
        return status({ phase: 'waiting' })
      }
      if (method === 'accounts.hostSignInCancel') {
        cancels += 1
        if (cancels === 1) {
          throw new Error('Remote runtime unavailable')
        }
        return status({ revision: 1_000, phase: 'cancelled' })
      }
      waits += 1
      const next = status({ revision: 1 + waits, phase: 'waiting' })
      // A long poll answers later; an instant answer would starve the timers this test waits on.
      return new Promise((resolve) => setTimeout(() => resolve(next), 5))
    }
    const adding = addCodexAccountOnHost(OWNER)
    await vi.waitFor(() => expect(waits).toBeGreaterThan(0))
    await expect(cancelHostAccountSignIn(OWNER, 'codex')).rejects.toThrow('unavailable')
    await expect(adding).rejects.toThrow('Codex sign-in was cancelled.')
    expect(cancels).toBe(2)
  })
})

describe('hostAccountSignInFailureText', () => {
  it('translates a coded host failure and keeps uncoded login text verbatim', async () => {
    const originalLanguage = i18n.language
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    try {
      const english = 'An account change on this host stopped the sign-in. Start it again.'
      expect(
        hostAccountSignInFailureText(
          status({ phase: 'failed', error: english, errorCode: 'superseded' })
        )
      ).toBe(es.accounts.hostSignIn.errors.superseded)
      expect(
        hostAccountSignInFailureText(
          status({ phase: 'failed', error: english, errorCode: 'fromNewerHost' })
        )
      ).toBe(english)
      expect(
        hostAccountSignInFailureText(status({ phase: 'failed', error: 'Codex login failed: boom' }))
      ).toBe('Codex login failed: boom')
    } finally {
      await i18n.changeLanguage(originalLanguage)
    }
  })
})

describe('retryLostAnswers', () => {
  it('asks again after lost answers until one arrives', async () => {
    vi.useFakeTimers()
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(timedOut())
      .mockRejectedValueOnce(Object.assign(new Error('socket closed'), { code: 'socket_closed' }))
      .mockResolvedValueOnce('answer')
    const result = retryLostAnswers(request)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(result).resolves.toBe('answer')
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('gives up once the window closes', async () => {
    vi.useFakeTimers()
    const request = vi.fn<() => Promise<string>>(() => Promise.reject(timedOut()))
    const result = retryLostAnswers(request)
    const settled = result.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(HOST_SIGN_IN_RETRY_WINDOW_MS + 5_000)
    expect(await settled).toMatchObject({ message: 'Request timed out' })
  })

  it('never retries a refusal, such as a flow the host no longer has', async () => {
    const request = vi.fn<() => Promise<string>>(() =>
      Promise.reject(new Error('This sign-in is no longer active in this client.'))
    )
    await expect(retryLostAnswers(request)).rejects.toThrow('no longer active')
    expect(request).toHaveBeenCalledOnce()
  })
})
