import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { buildNativeChatProviderUpdate } from '../../../shared/native-chat/native-chat-providers'
import { nativeChatPreferenceFor } from '../../../shared/structured-native-chat-launch-route'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

const SETTINGS_KEY = 'orca.web.settings.v1'

async function loadSettings(stored: Record<string, unknown> | null) {
  const globals = installBrowserGlobals('Linux')
  if (stored) {
    globals.storage.setItem(SETTINGS_KEY, JSON.stringify(stored))
  }
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  const settings = await globals.window.api.settings.get()
  const saved: Record<string, unknown> = JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')
  return { settings, saved, globals }
}

const oldHost = vi.hoisted(() => {
  const calls: string[] = []
  const state: {
    on: boolean
    fail: boolean
    calls: string[]
    reply?: Record<string, unknown>
    call?: (
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number }
    ) => Promise<RuntimeRpcResponse<unknown>>
  } = { on: false, fail: false, calls }
  return state
})
vi.mock('./web-runtime-client', () => ({
  WebRuntimeClient: class {
    async call(method: string, params?: unknown, options?: { timeoutMs?: number }) {
      oldHost.calls.push(method)
      if (oldHost.call) {
        return oldHost.call(method, params, options)
      }
      if (oldHost.fail) {
        throw new Error('offline')
      }
      return {
        id: method,
        ok: true,
        _meta: { runtimeId: 'released-host' },
        result: {
          settings: oldHost.reply ?? {
            experimentalNativeChat: oldHost.on,
            experimentalStructuredNativeChat: oldHost.on,
            openAgentTabsInChatByDefault: false,
            agentDefaultSurface: oldHost.on ? 'chat' : 'terminal',
            nativeChatProviders: { claude: oldHost.on, codex: oldHost.on },
            compactWorktreeCards: true,
            minimaxGroupId: 'live-host-group'
          }
        }
      }
    }
    close() {}
  }
}))

describe('current browser owner at remote settlement', () => {
  beforeEach(() => {
    vi.resetModules()
    oldHost.fail = false
    oldHost.call = undefined
    oldHost.reply = undefined
    oldHost.calls = []
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const methods = ['settings.get', 'settings.update', 'settings.updatePRBotAuthorOverride'] as const
  async function paired(initialChat = false) {
    const { globals } = await loadSettings({
      agentDefaultSurface: initialChat ? 'chat' : 'terminal',
      nativeChatProviders: { 'acme-agent': true }
    })
    writeStoredRuntimeEnvironment(globals.storage)
    vi.resetModules()
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    return globals
  }
  function syncSettings(api: Window['api']) {
    const settings = api.settings.getSync()
    expect(settings).not.toBeNull()
    if (settings === null) {
      throw new Error('Browser settings must be synchronously available')
    }
    return settings
  }
  function start(api: Window['api'], method: string, visibility = false) {
    if (method === 'settings.get') {
      return api.settings.get()
    }
    if (method === 'settings.update') {
      return api.settings.set(
        visibility
          ? { worktreeVisibilityDefaults: { external: 'show' } }
          : { compactWorktreeCards: false }
      )
    }
    return api.settings.updatePRBotAuthorOverride({ author: ' Robot ', isBot: true })
  }
  async function choose(api: Window['api'], chat: boolean) {
    const current = await api.settings.set({ agentDefaultSurface: chat ? 'chat' : 'terminal' })
    return api.settings.set(buildNativeChatProviderUpdate(current, 'codex', !chat))
  }
  function check(settings: Awaited<ReturnType<Window['api']['settings']['get']>>, chat: boolean) {
    expect(settings.agentDefaultSurface).toBe(chat ? 'chat' : 'terminal')
    expect(settings.nativeChatProviders).toEqual({ 'acme-agent': true, codex: !chat })
    expect(nativeChatPreferenceFor(settings, 'future-agent')).toBe(chat)
    expect(nativeChatPreferenceFor(settings, 'codex')).toBe(!chat)
  }
  function delay() {
    let release = (_settings?: Record<string, unknown>) => {}
    let reject = (_reason: Error) => {}
    let enter = () => {}
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    oldHost.call = (method) =>
      new Promise((resolve, fail) => {
        release = (settings) =>
          resolve({
            id: method,
            ok: true,
            result: { settings: settings ?? {} },
            _meta: { runtimeId: 'released-host' }
          })
        reject = fail
        enter()
      })
    return {
      entered,
      release: (settings?: Record<string, unknown>) => release(settings),
      reject: (error: Error) => reject(error)
    }
  }

  it.each(methods.flatMap((method) => [false, true].map((chat) => ({ method, chat }))))(
    'retains current intent through delayed $method with Chat=$chat, persistence and reopen',
    async ({ method, chat }) => {
      const globals = await paired(!chat)
      const pending = delay()
      const earlier = start(globals.window.api, method)
      await pending.entered
      await choose(globals.window.api, chat)
      const replacement = {
        ...JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}'),
        experimentalNativeChat: { replacement: chat }
      }
      globals.storage.setItem(SETTINGS_KEY, JSON.stringify(replacement))
      pending.release({
        compactWorktreeCards: true,
        prBotAuthorOverrides: [' Robot '],
        ...(chat
          ? {
              experimentalNativeChat: false,
              experimentalStructuredNativeChat: false,
              openAgentTabsInChatByDefault: false,
              agentDefaultSurface: 'terminal',
              nativeChatProviders: { codex: true }
            }
          : {})
      })
      const returned = await earlier
      check(returned, chat)
      expect(returned).not.toHaveProperty('experimentalNativeChat')
      expect(
        JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}').experimentalNativeChat
      ).toEqual({ replacement: chat })
      if (method === 'settings.updatePRBotAuthorOverride') {
        expect(returned.prBotAuthorOverrides).toEqual(['robot'])
      } else {
        expect(returned.compactWorktreeCards).toBe(true)
      }
      check(syncSettings(globals.window.api), chat)
      expect(JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')).toMatchObject({
        agentDefaultSurface: returned.agentDefaultSurface,
        nativeChatProviders: returned.nativeChatProviders
      })
      oldHost.call = undefined
      vi.resetModules()
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      check(await globals.window.api.settings.get(), chat)
      check(
        await globals.window.api.settings.set({ agentDefaultSurface: chat ? 'chat' : 'terminal' }),
        chat
      )
    }
  )
})
