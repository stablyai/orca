import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

it.each([true, false])(
  'reads host consent and only writes it to capable web hosts (supported=%s)',
  async (supported) => {
    let consent = true
    const updates: unknown[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'settings.update') {
            updates.push(params)
            if (
              typeof params === 'object' &&
              params !== null &&
              'nativeChatAutoContinueAfterUsageLimit' in params
            ) {
              consent = params.nativeChatAutoContinueAfterUsageLimit === true
            }
          }
          return Promise.resolve({
            id: 'reply',
            ok: true,
            result:
              method === 'status.get'
                ? {
                    capabilities: supported
                      ? [AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY]
                      : []
                  }
                : { settings: supported ? { nativeChatAutoContinueAfterUsageLimit: consent } : {} },
            _meta: { runtimeId: 'runtime-1' }
          })
        }
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api.settings
    expect((await api.get()).nativeChatAutoContinueAfterUsageLimit).toBe(
      supported ? true : undefined
    )
    await api.set({ nativeChatAutoContinueAfterUsageLimit: false })
    expect(updates).toEqual(supported ? [{ nativeChatAutoContinueAfterUsageLimit: false }] : [])
    expect((await api.get()).nativeChatAutoContinueAfterUsageLimit).toBe(
      supported ? false : undefined
    )
  }
)

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
  expect(api.getSync().nativeChatAutoContinueAfterUsageLimit).toBeUndefined()
  expect((await api.get()).nativeChatAutoContinueAfterUsageLimit).toBe(true)
  const a = webRuntimeState.activeEnvironment!
  webRuntimeState.activeEnvironment = { ...a, id: 'server-B', pairingRevision: 2 }
  hostConsent = false
  failure = true
  expect((await api.get()).nativeChatAutoContinueAfterUsageLimit).toBeUndefined()
  expect(api.getSync().nativeChatAutoContinueAfterUsageLimit).toBeUndefined()
  failure = false
  expect((await api.get()).nativeChatPermissionMode).toBe('full-access')
  expect(api.getSync().nativeChatAutoContinueAfterUsageLimit).toBe(false)
  rejectWrite = true
  await expect(api.set({ nativeChatAutoContinueAfterUsageLimit: true })).rejects.toThrow('offline')
  expect(api.getSync().nativeChatAutoContinueAfterUsageLimit).toBe(false)
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
    expect(api.getSync().nativeChatAutoContinueAfterUsageLimit).toBeUndefined()
    hold = undefined
  }
  expect(globals.storage.getItem('orca.web.settings.v1')).not.toContain(
    'nativeChatAutoContinueAfterUsageLimit'
  )
})
