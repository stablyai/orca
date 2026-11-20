import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

vi.mock('./preload-api/web-runtime-api', () => ({
  createWebRuntimeApi: () => ({
    subscribe: vi.fn(async (_request, onResponse) => {
      onResponse({
        ok: true,
        result: { mode: 'auto', active: true }
      })
      return { unsubscribe: vi.fn() }
    })
  })
}))

function installTauriHost() {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn(() => Promise.resolve({ mode: 'auto', active: true }))
  const listeners: { event: string; handler: (message: { payload: unknown }) => void }[] = []
  const event = {
    listen: vi.fn(async (name: string, handler: (message: { payload: unknown }) => void) => {
      listeners.push({ event: name, handler })
      return () => {}
    })
  }
  Object.assign(globals.window, {
    __TAURI_INTERNALS__: { invoke },
    __TAURI__: { event }
  })
  return { invoke, listeners }
}

describe('createTauriNativeAgentAwakeApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reads status from Rust and forwards the orcad verdict stream', async () => {
    const host = installTauriHost()
    const { createTauriNativeAgentAwakeApi } = await import('./tauri-native-agent-awake-api')
    const api = createTauriNativeAgentAwakeApi()
    expect(api).toBeDefined()

    await expect(api?.getStatus()).resolves.toEqual({ mode: 'auto', active: true })
    expect(host.invoke).toHaveBeenCalledWith('poc_agent_awake_status', undefined)

    // The startup subscription pushes each orcad verdict into the shell's OS
    // blocker.
    await vi.waitFor(() => {
      expect(host.invoke).toHaveBeenCalledWith('poc_agent_awake_set_active', {
        mode: 'auto',
        active: true
      })
    })
  })

  it('forwards agentAwake:changed events from Rust to the shared contract', async () => {
    const host = installTauriHost()
    const { createTauriNativeAgentAwakeApi } = await import('./tauri-native-agent-awake-api')
    const api = createTauriNativeAgentAwakeApi()
    const callback = vi.fn()
    api?.onChanged(callback)
    await Promise.resolve()
    await Promise.resolve()

    const listener = host.listeners.find((entry) => entry.event === 'agentAwake:changed')
    listener?.handler({ payload: { mode: 'on', active: true } })
    expect(callback).toHaveBeenCalledWith({ mode: 'on', active: true })
  })

  it('returns undefined off the Tauri host', async () => {
    installBrowserGlobals('Windows')
    const { createTauriNativeAgentAwakeApi } = await import('./tauri-native-agent-awake-api')
    expect(createTauriNativeAgentAwakeApi()).toBeUndefined()
  })
})
