import { afterEach, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_CHAT_SIGN_IN_INTENT_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY
} from '../../../shared/remote-runtime/protocol/account-runtime-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/remote-runtime/protocol/protocol-version'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from './rpc/compatibility/runtime-compatibility-cache'
import { callAntigravityChatSignIn } from './provider-accounts/sign-in/runtime-antigravity-accounts-client'

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
