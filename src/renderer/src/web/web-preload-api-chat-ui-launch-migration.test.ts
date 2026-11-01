import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { createPairedE2EEClientHandshake } from '../../../shared/paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/paired-e2ee-node-primitives'
import { WebRuntimeRequestRegistry } from './web-runtime-request-registry'
import { routeWebRuntimeConnectionFrame } from './web-runtime-connection-frame-router'
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

describe('web Chat UI launch migration', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('turns chat choices the switch masked to CLI for a browser profile saved with Chat UI off, once', async () => {
    const { settings, saved, globals } = await loadSettings({
      experimentalNativeChat: false,
      nativeChatProviders: { claude: true, codex: false }
    })

    expect(settings.agentDefaultSurface).toBe('terminal')
    expect(settings.nativeChatProviders).toEqual({})
    expect(saved).toHaveProperty('experimentalNativeChat', false)
    expect(saved.nativeChatProviders).toEqual(settings.nativeChatProviders)

    // The raw modern default marks completion: later choices survive with the original data retained.
    globals.storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...saved, nativeChatProviders: { claude: true } })
    )
    vi.resetModules()
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect((await globals.window.api.settings.get()).nativeChatProviders).toEqual({ claude: true })
  })

  it('keeps agents without a choice on chat for a browser profile saved with Chat UI on', async () => {
    const { settings, saved } = await loadSettings({
      experimentalNativeChat: true,
      nativeChatProviders: { codex: false }
    })

    expect(settings.agentDefaultSurface).toBe('chat')
    expect(settings.nativeChatProviders).toEqual({ codex: false })
    expect(saved).toHaveProperty('experimentalNativeChat', true)
  })

  it('writes nothing for a browser profile without the switch', async () => {
    const { settings } = await loadSettings({ theme: 'dark' })

    expect(settings.nativeChatProviders).toBeUndefined()
  })
})

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

it.each([
  { name: 'upgraded on', stored: { experimentalNativeChat: true }, expected: true },
  { name: 'upgraded off', stored: { experimentalNativeChat: false }, expected: false },
  { name: 'fresh', stored: {}, expected: false }
])(
  'keeps $name browser choices through old-host responses, edits, offline and reopen',
  async ({ stored, expected }) => {
    for (const hostOn of [false, true]) {
      vi.resetModules()
      oldHost.on = hostOn
      oldHost.fail = false
      oldHost.calls = []
      const { globals, settings: initial } = await loadSettings(stored)
      expect(nativeChatPreferenceFor(initial, 'claude')).toBe(expected)
      writeStoredRuntimeEnvironment(globals.storage)
      // Reinstall so the real API reads its now-paired host from storage.
      vi.resetModules()
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      let defaultChat = expected
      const check = (
        settings: Awaited<ReturnType<typeof globals.window.api.settings.get>>,
        choice: boolean
      ) => {
        expect(nativeChatPreferenceFor(settings, 'claude')).toBe(choice)
        expect(settings.agentDefaultSurface).toBe(defaultChat ? 'chat' : 'terminal')
        expect(nativeChatPreferenceFor(settings, 'new-agent')).toBe(defaultChat)
        const saved = JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')
        for (const key of [
          'experimentalNativeChat',
          'experimentalStructuredNativeChat',
          'openAgentTabsInChatByDefault'
        ]) {
          expect(settings).not.toHaveProperty(key)
          if (key === 'experimentalNativeChat' && 'experimentalNativeChat' in stored) {
            expect(saved[key]).toBe(stored.experimentalNativeChat)
          } else {
            expect(saved).not.toHaveProperty(key)
          }
        }
        expect(saved.nativeChatProviders).toEqual(settings.nativeChatProviders)
        expect(saved.agentDefaultSurface).toBe(settings.agentDefaultSurface)
      }
      for (const [stage, choice] of [expected, true, false].entries()) {
        if (stage > 0) {
          await globals.window.api.settings.set({ nativeChatProviders: { claude: choice } })
        }
        for (let iteration = 0; iteration < 2; iteration++) {
          const returned = await globals.window.api.settings.set({ compactWorktreeCards: false })
          check(returned, choice)
          expect(returned.compactWorktreeCards).toBe(true)
          expect(returned.minimaxGroupId).toBe('live-host-group')
          check(await globals.window.api.settings.get(), choice)
          vi.resetModules()
          const reopened = await import('./web-preload-api')
          reopened.installWebPreloadApi()
          check(await globals.window.api.settings.get(), choice)
        }
        oldHost.fail = true
        check(await globals.window.api.settings.set({ compactWorktreeCards: false }), choice)
        check(await globals.window.api.settings.get(), choice)
        oldHost.fail = false
      }
      oldHost.fail = false
      const map = (await globals.window.api.settings.get()).nativeChatProviders
      defaultChat = !expected
      await globals.window.api.settings.set({
        agentDefaultSurface: defaultChat ? 'chat' : 'terminal'
      })
      const flipped = await globals.window.api.settings.set({ compactWorktreeCards: false })
      expect(flipped.nativeChatProviders).toEqual(map)
      check(flipped, false)
      vi.resetModules()
      const afterFlip = await import('./web-preload-api')
      afterFlip.installWebPreloadApi()
      check(await globals.window.api.settings.get(), false)
      expect(oldHost.calls).toContain('settings.update')
      expect(oldHost.calls).toContain('settings.get')
    }
  }
)

it('normalizes invalid browser defaults without inventing an override', async () => {
  const { settings } = await loadSettings({ agentDefaultSurface: 'invalid' })
  expect(settings.agentDefaultSurface).toBe('terminal')
  expect(nativeChatPreferenceFor(settings, 'later-agent')).toBe(false)
})

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

  it.each(methods)(
    'settles delayed %s rejection without rolling back newer local edits',
    async (method) => {
      const globals = await paired()
      const pending = delay()
      const earlier = start(globals.window.api, method)
      const outcome =
        method === 'settings.updatePRBotAuthorOverride'
          ? expect(earlier).rejects.toThrow('offline')
          : earlier
      await pending.entered
      await choose(globals.window.api, true)
      pending.reject(new Error('offline'))
      if (method === 'settings.updatePRBotAuthorOverride') {
        await outcome
      } else {
        check(await earlier, true)
      }
      check(syncSettings(globals.window.api), true)
    }
  )

  it('preserves visibility rejection after a newer local choice', async () => {
    const globals = await paired()
    oldHost.reply = { worktreeVisibilityDefaults: { external: 'hide' } }
    await globals.window.api.settings.get()
    const pending = delay()
    const rejected = expect(start(globals.window.api, 'settings.update', true)).rejects.toThrow(
      'offline'
    )
    await pending.entered
    await choose(globals.window.api, true)
    pending.reject(new Error('offline'))
    await rejected
    check(syncSettings(globals.window.api), true)
    expect(syncSettings(globals.window.api).worktreeVisibilityDefaults).toEqual({
      external: 'hide'
    })
  })

  it('keeps broad update fields and omissions distinct from get and bot projections', async () => {
    const globals = await paired()
    const fields = {
      sourceControlAi: {
        actions: {
          fixChecks: {
            agentId: 'codex',
            commandInputTemplate: 'Fix checks',
            agentArgs: '--verbose'
          }
        }
      },
      hostSettingOverrides: { local: { displayLabel: 'Desk' } },
      terminalCopyTrimsGutter: false,
      agentDefaultArgs: { codex: '--quiet' },
      defaultRepoSelection: null,
      machineName: 'host-name',
      artifactSharingEnabled: true,
      agentSkillSharingEnabled: true
    }
    oldHost.reply = fields
    const updated = await globals.window.api.settings.set({ compactWorktreeCards: false })
    expect(updated).toMatchObject(fields)
    oldHost.reply = {}
    const omitted = await globals.window.api.settings.set({ compactWorktreeCards: true })
    expect(omitted).toMatchObject(fields)
    oldHost.reply = { machineName: undefined }
    expect(
      (await globals.window.api.settings.set({ compactWorktreeCards: false })).machineName
    ).toBeUndefined()
    oldHost.reply = {
      machineName: 'ignored-get-name',
      sourceControlAi: { actions: {} },
      hostSettingOverrides: {},
      terminalCopyTrimsGutter: true
    }
    const read = await globals.window.api.settings.get()
    expect(read).toMatchObject({
      ...fields,
      machineName: '',
      artifactSharingEnabled: false,
      agentSkillSharingEnabled: false
    })
    const bot = await globals.window.api.settings.updatePRBotAuthorOverride({
      author: 'robot',
      isBot: true
    })
    expect(bot.prBotAuthorOverrides).toEqual([])
    expect(bot).toMatchObject({
      sourceControlAi: fields.sourceControlAi,
      hostSettingOverrides: fields.hostSettingOverrides
    })
  })

  it('times out dropped replies, pumps a queued successor and ignores their late frames', async () => {
    const globals = await paired()
    vi.useFakeTimers()
    Object.assign(globals.window, { setTimeout, clearTimeout })
    let sentAll = () => {}
    const sent = new Promise<void>((resolve) => {
      sentAll = resolve
    })
    let id = 0
    const registry = new WebRuntimeRequestRegistry({
      deviceToken: 'fixture-token',
      nextId: () => String(++id),
      waitForConnected: async () => {},
      sendEncrypted: () => {
        if (id === 8) {
          sentAll()
        }
        return true
      }
    })
    oldHost.call = (method, params, options) => registry.call(method, params, options)
    const earlier = Array.from({ length: 8 }, () => globals.window.api.settings.get())
    await sent
    const successor = globals.window.api.settings.get()
    expect(id).toBe(8)
    await choose(globals.window.api, true)
    await vi.advanceTimersByTimeAsync(15_000)
    for (const result of await Promise.all(earlier)) {
      check(result, true)
    }
    expect([...registry.pending.keys()]).toEqual(['9'])
    const host = nacl.box.keyPair(),
      client = nacl.box.keyPair()
    const handshake = createPairedE2EEClientHandshake({
      primitives: NODE_PAIRED_E2EE_PRIMITIVES,
      hostPublicKeyB64: Buffer.from(host.publicKey).toString('base64'),
      framing: 'legacy',
      clientKeyPair: client
    })
    const route = (requestId: string, settings: Record<string, unknown>) => {
      const nonce = nacl.randomBytes(nacl.box.nonceLength)
      const payload = Buffer.from(
        JSON.stringify({
          id: requestId,
          ok: true,
          result: { settings },
          _meta: { runtimeId: 'released-host' }
        })
      )
      const encrypted = nacl.box.after(
        payload,
        nonce,
        nacl.box.before(client.publicKey, host.secretKey)
      )
      return routeWebRuntimeConnectionFrame(
        Buffer.concat([Buffer.from(nonce), Buffer.from(encrypted)]).toString('base64'),
        undefined,
        {
          getState: () => 'connected',
          getHandshake: () => handshake,
          getSocket: () => null,
          pending: registry.pending,
          subscriptions: new Map(),
          sendAuth: () => {},
          setConnected: () => {},
          authRejected: () => {}
        }
      )
    }
    const beforeLate = globals.storage.getItem(SETTINGS_KEY)
    await route('1', {
      agentDefaultSurface: 'terminal',
      nativeChatProviders: {},
      compactWorktreeCards: false
    })
    expect(globals.storage.getItem(SETTINGS_KEY)).toBe(beforeLate)
    expect(registry.pending.size).toBe(1)
    await route('9', { compactWorktreeCards: true })
    check(await successor, true)
    expect(registry.pending.size).toBe(0)
    expect(syncSettings(globals.window.api).compactWorktreeCards).toBe(true)
    oldHost.call = undefined
    vi.resetModules()
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    check(await globals.window.api.settings.get(), true)
  })

  it.each([false, true])(
    'bounds no-request edits with paired=%s through storage, sync read and reopen',
    async (isPaired) => {
      const counts: number[][] = []
      for (const n of [100, 1000]) {
        vi.resetModules()
        const map = Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`registered-${i}`, false])
        )
        const { globals } = await loadSettings({
          experimentalNativeChat: true,
          nativeChatProviders: map
        })
        if (isPaired) {
          writeStoredRuntimeEnvironment(globals.storage)
          vi.resetModules()
          const { installWebPreloadApi } = await import('./web-preload-api')
          installWebPreloadApi()
        }
        const normalization = await import('./preload-api/web-preference-normalization')
        const visibility = await import('../../../shared/external-worktree-visibility')
        const bots = await import('../../../shared/pr-bot-author-overrides')
        const merge = vi.spyOn(normalization, 'mergeSettings')
        const migrate = vi.spyOn(normalization, 'migrateStoredWebSettings')
        const permissions = vi.spyOn(normalization, 'runtimeChatPermissionSetting')
        const visibilityDefaults = vi.spyOn(visibility, 'normalizeWorktreeVisibilityDefaults')
        const botOverrides = vi.spyOn(bots, 'normalizePRBotAuthorOverrides')
        const reads = vi.spyOn(globals.storage, 'getItem')
        const writes = vi.spyOn(globals.storage, 'setItem')
        const calls = oldHost.calls.length
        const current = await globals.window.api.settings.set({ agentDefaultSurface: 'terminal' })
        const returned = await globals.window.api.settings.set(
          buildNativeChatProviderUpdate(current, 'codex', true)
        )
        counts.push([
          reads.mock.calls.filter(([key]) => key === SETTINGS_KEY).length,
          writes.mock.calls.filter(([key]) => key === SETTINGS_KEY).length,
          merge.mock.calls.length,
          migrate.mock.calls.length,
          visibilityDefaults.mock.calls.length,
          permissions.mock.calls.length,
          botOverrides.mock.calls.length,
          oldHost.calls.length - calls
        ])
        reads.mockClear()
        const explicit = await globals.window.api.settings.setActiveRuntimeEnvironmentPreference({
          environmentId: null
        })
        expect(reads.mock.calls.filter(([key]) => key === SETTINGS_KEY)).toHaveLength(3)
        expect(explicit).not.toHaveProperty('experimentalNativeChat')
        vi.restoreAllMocks()
        const expected = {
          agentDefaultSurface: 'terminal',
          nativeChatProviders: { ...map, codex: true }
        }
        expect(returned).toMatchObject(expected)
        expect(syncSettings(globals.window.api)).toMatchObject(expected)
        const saved = JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')
        expect(saved).toMatchObject(expected)
        expect(saved).toHaveProperty('experimentalNativeChat', true)
        expect(nativeChatPreferenceFor(returned, 'future-agent')).toBe(false)
        expect(nativeChatPreferenceFor(returned, 'codex')).toBe(true)
        vi.resetModules()
        const { installWebPreloadApi } = await import('./web-preload-api')
        installWebPreloadApi()
        expect(syncSettings(globals.window.api)).toMatchObject(expected)
        expect(oldHost.calls.length).toBe(calls)
      }
      // Two local edits: each reads/migrates twice and performs its existing migration plus regular saves.
      const expected = [10, 6, 6, 4, isPaired ? 2 : 0, isPaired ? 2 : 0, 0, 0]
      expect(counts).toEqual([expected, expected])
    }
  )

  it('bounds storage and transport operations at N and 10N saved overrides', async () => {
    const counts: number[][] = []
    for (const n of [100, 1000]) {
      vi.resetModules()
      const map = Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`registered-${i}`, false])
      )
      const { globals } = await loadSettings({
        agentDefaultSurface: 'chat',
        nativeChatProviders: map
      })
      writeStoredRuntimeEnvironment(globals.storage)
      const pending = delay()
      const calls = oldHost.calls.length
      const earlier = globals.window.api.settings.updatePRBotAuthorOverride({
        author: 'robot',
        isBot: true
      })
      await pending.entered
      const reads = vi.spyOn(globals.storage, 'getItem'),
        writes = vi.spyOn(globals.storage, 'setItem')
      pending.release({ prBotAuthorOverrides: ['robot'] })
      const returned = await earlier
      counts.push([
        reads.mock.calls.filter(([key]) => key === SETTINGS_KEY).length,
        writes.mock.calls.filter(([key]) => key === SETTINGS_KEY).length,
        oldHost.calls.length - calls
      ])
      expect(returned.nativeChatProviders).toEqual(map)
      reads.mockRestore()
      writes.mockRestore()
      oldHost.call = undefined
    }
    // Existing read-time normalization saves once; settlement adds one regular save, not per-agent writes.
    expect(counts).toEqual([
      [3, 2, 1],
      [3, 2, 1]
    ])
  })
})

it.each([null, { future: [false, 1] }, true, false])(
  'keeps raw %j private across local APIs, ignored input, active host and reopen',
  async (original) => {
    vi.resetModules()
    oldHost.call = undefined
    oldHost.reply = undefined
    oldHost.fail = false
    const { globals } = await loadSettings({ experimentalNativeChat: original })
    const input = {
      experimentalNativeChat: 'must-not-replace',
      experimentalStructuredNativeChat: true,
      openAgentTabsInChatByDefault: true,
      agentDefaultSurface: 'chat' as const,
      nativeChatProviders: { 'registered-agent': false }
    }
    const outputs = [
      await globals.window.api.settings.set(input),
      globals.window.api.settings.getSync(),
      await globals.window.api.settings.setActiveRuntimeEnvironmentPreference({
        environmentId: null
      }),
      await globals.window.api.settings.updatePRBotAuthorOverride({ author: 'robot', isBot: true })
    ]
    for (const live of outputs) {
      expect(live).not.toHaveProperty('experimentalNativeChat')
      expect(live).not.toHaveProperty('experimentalStructuredNativeChat')
      expect(live).not.toHaveProperty('openAgentTabsInChatByDefault')
    }
    const saved = JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')
    expect(saved.experimentalNativeChat).toEqual(original)
    expect(saved).not.toHaveProperty('experimentalStructuredNativeChat')
    vi.resetModules()
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect(await globals.window.api.settings.get()).toMatchObject({
      agentDefaultSurface: 'chat',
      nativeChatProviders: { 'registered-agent': false }
    })
    expect(
      JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}').experimentalNativeChat
    ).toEqual(original)
  }
)

it.each(['terminal', null, 'future-value'])(
  'honors raw modern presence %j over retained legacy on',
  async (modern) => {
    vi.resetModules()
    const { settings, saved } = await loadSettings({
      experimentalNativeChat: true,
      agentDefaultSurface: modern,
      nativeChatProviders: { 'registered-agent': true }
    })
    expect(settings.agentDefaultSurface).toBe('terminal')
    expect(settings.nativeChatProviders).toEqual({ 'registered-agent': true })
    expect(settings).not.toHaveProperty('experimentalNativeChat')
    expect(saved.experimentalNativeChat).toBe(true)
  }
)

it('cannot create retained metadata on a fresh owner from public input', async () => {
  vi.resetModules()
  const { globals } = await loadSettings({})
  const input = { theme: 'dark' as const, experimentalNativeChat: true }
  expect(await globals.window.api.settings.set(input)).not.toHaveProperty('experimentalNativeChat')
  expect(JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')).not.toHaveProperty(
    'experimentalNativeChat'
  )
})

it('finishes carry after failed migration write, legitimate read wake, opposite edit and reopen', async () => {
  vi.resetModules()
  oldHost.call = undefined
  const globals = installBrowserGlobals('Linux')
  globals.storage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ experimentalNativeChat: true, nativeChatProviders: { codex: false } })
  )
  const write = globals.storage.setItem.bind(globals.storage)
  let blocked = true
  const writes = vi.spyOn(globals.storage, 'setItem').mockImplementation((key, value) => {
    if (key === SETTINGS_KEY && blocked) {
      throw new Error('storage full')
    }
    write(key, value)
  })
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  const before = writes.mock.calls.length
  expect((await globals.window.api.settings.get()).agentDefaultSurface).toBe('chat')
  expect(writes.mock.calls.length - before).toBe(1)
  expect(JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')).not.toHaveProperty(
    'agentDefaultSurface'
  )
  blocked = false
  expect(globals.window.api.settings.getSync()?.agentDefaultSurface).toBe('chat')
  expect(JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')).toMatchObject({
    experimentalNativeChat: true,
    agentDefaultSurface: 'chat',
    nativeChatProviders: { codex: false }
  })
  await globals.window.api.settings.set({
    agentDefaultSurface: 'terminal',
    nativeChatProviders: { codex: true }
  })
  vi.resetModules()
  const reopened = await import('./web-preload-api')
  reopened.installWebPreloadApi()
  const beforeRead = writes.mock.calls.length
  expect(await globals.window.api.settings.get()).toMatchObject({
    agentDefaultSurface: 'terminal',
    nativeChatProviders: { codex: true }
  })
  // Existing theme normalization still writes once; carry contributes no additional save/re-entry.
  expect(writes.mock.calls.length - beforeRead).toBe(1)
  expect(JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}').experimentalNativeChat).toBe(
    true
  )
  writes.mockRestore()
})
