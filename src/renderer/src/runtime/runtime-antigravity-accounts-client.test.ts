import { afterEach, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_CHAT_SIGN_IN_INTENT_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY
} from '../../../shared/account-runtime-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  callAntigravityChatSignIn,
  subscribeAntigravityChatSignIn
} from './runtime-antigravity-accounts-client'

afterEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.unstubAllGlobals()
})

it('sends explicit actions only to advertising hosts and keeps the legacy host path usable', async () => {
  for (const modern of [true, false]) {
    clearRuntimeCompatibilityCacheForTests()
    const call = vi.fn(async ({ method }: { method: string }) => ({
      id: method,
      ok: true,
      result:
        method === 'status.get'
          ? {
              runtimeId: 'remote-runtime',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
              capabilities: [
                ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY,
                ...(modern ? [ANTIGRAVITY_CHAT_SIGN_IN_INTENT_RUNTIME_CAPABILITY] : [])
              ]
            }
          : { flowId: 'accepted' },
      _meta: { runtimeId: 'remote-runtime' }
    }))
    const local = vi.fn(async () => ({
      id: 'local',
      ok: true,
      result: { flowId: 'local' },
      _meta: { runtimeId: 'local' }
    }))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call }, runtime: { call: local } } })
    await expect(
      callAntigravityChatSignIn({ kind: 'environment', environmentId: 'host' }, 'Start', {
        intent: 'changeAccount'
      })
    ).resolves.toMatchObject({
      result: { flowId: 'accepted' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    expect(call).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'accounts.antigravityChatSignInStart',
        params: modern ? { intent: 'changeAccount' } : undefined,
        ...(modern ? { expectedEnvironmentRuntimeId: 'remote-runtime' } : {})
      })
    )
    await callAntigravityChatSignIn({ kind: 'local' }, 'Start', { intent: 'signIn' })
    expect(local).toHaveBeenCalledWith({
      method: 'accounts.antigravityChatSignInStart',
      params: { intent: 'signIn' }
    })
  }
})

it('keeps the source runtime identity with a sign-in status frame', async () => {
  const status = { revision: 1, auth: 'unknown', flow: null }
  const subscribe = vi.fn(async (_, onResponse) => {
    onResponse({ id: 'status', ok: true, result: status, _meta: { runtimeId: 'source-runtime' } })
    return { unsubscribe: vi.fn() }
  })
  vi.stubGlobal('window', { api: { runtime: { subscribe } } })
  const onEvent = vi.fn()
  await subscribeAntigravityChatSignIn(
    { kind: 'local' },
    {
      onEvent,
      onError: vi.fn(),
      onClose: vi.fn()
    }
  )
  expect(onEvent).toHaveBeenCalledExactlyOnceWith({ ...status, runtimeId: 'source-runtime' })
})
