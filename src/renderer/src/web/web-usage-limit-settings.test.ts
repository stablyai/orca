import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-create-capabilities'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

it('keeps consent with its pairing through failures, late responses and rejected writes', async () => {
  let failure = false
  let hostConsent = true
  let hold: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
  let delayed: string | undefined
  let rejectWrite = false
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string): Promise<RuntimeRpcResponse<unknown>> {
        if (method === delayed) {
          return new Promise((resolve) => {
            hold = resolve
          })
        }
        if (
          (method === 'settings.get' && failure) ||
          (method === 'settings.update' && rejectWrite)
        ) {
          return Promise.reject(new Error('offline'))
        }
        return Promise.resolve({
          id: 'reply',
          ok: true,
          _meta: { runtimeId: 'runtime-1' },
          result:
            method === 'status.get'
              ? { capabilities: [AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY] }
              : {
                  settings: {
                    nativeChatAutoContinueAfterUsageLimit: hostConsent,
                    nativeChatPermissionMode: 'full-access'
                  }
                }
        })
      }
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals('Linux')
  writeStoredRuntimeEnvironment(globals.storage)
  globals.storage.setItem(
    'orca.web.settings.v1',
    JSON.stringify({ nativeChatAutoContinueAfterUsageLimit: true })
  )
  const { installWebPreloadApi } = await import('./web-preload-api')
  const { webRuntimeState } = await import('./preload-api/web-runtime-session')
  installWebPreloadApi()
  const api = globals.window.api.settings
  const consent = () => {
    const settings = api.getSync()
    expect(settings).not.toBeNull()
    return settings?.nativeChatAutoContinueAfterUsageLimit
  }
  expect(consent()).toBeUndefined()
  expect((await api.get()).nativeChatAutoContinueAfterUsageLimit).toBe(true)
  const a = webRuntimeState.activeEnvironment!
  webRuntimeState.activeEnvironment = { ...a, id: 'server-B', pairingRevision: 2 }
  hostConsent = false
  failure = true
  expect((await api.get()).nativeChatAutoContinueAfterUsageLimit).toBeUndefined()
  expect(consent()).toBeUndefined()
  failure = false
  expect((await api.get()).nativeChatPermissionMode).toBe('full-access')
  expect(consent()).toBe(false)
  rejectWrite = true
  await expect(api.set({ nativeChatAutoContinueAfterUsageLimit: true })).rejects.toThrow('offline')
  expect(consent()).toBe(false)
  rejectWrite = false
  for (const method of ['settings.get', 'settings.update', 'status.get']) {
    delayed = method
    const pending =
      method === 'settings.get'
        ? api.get()
        : api.set({ nativeChatAutoContinueAfterUsageLimit: true })
    await vi.waitFor(() => expect(hold).toBeTypeOf('function'))
    webRuntimeState.activeEnvironment = {
      ...a,
      pairingRevision: (webRuntimeState.activeEnvironment!.pairingRevision ?? 2) + 1
    }
    hold!({
      id: 'late',
      ok: true,
      _meta: { runtimeId: 'runtime-1' },
      result:
        method === 'status.get'
          ? { capabilities: [AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY] }
          : { settings: { nativeChatAutoContinueAfterUsageLimit: true } }
    })
    await pending.catch(() => undefined)
    expect(consent()).toBeUndefined()
    hold = undefined
  }
  expect(globals.storage.getItem('orca.web.settings.v1')).not.toContain(
    'nativeChatAutoContinueAfterUsageLimit'
  )
})
