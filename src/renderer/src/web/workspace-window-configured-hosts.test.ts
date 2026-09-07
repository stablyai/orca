import { afterEach, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it.each([false, true])(
  'restores closed views across subscription rebuild and reload (secondary=%s)',
  async (secondary) => {
    const globals = installBrowserGlobals()
    if (secondary) {
      Object.assign(globals.window, { orcaWorkspaceWindowNative: {} })
    }
    const owner = { environmentId: 'configured', pairingRevision: 42 }
    let intents = await import('../runtime/web-session-close-intent')
    intents.recordWebSessionCloseIntent(owner, 'workspace', 'closed', 1)
    intents.makeWebSessionCloseIntentDurable(owner, 'workspace', 'closed', true)
    intents.clearWebSessionCloseIntentsForWorktree(owner, 'workspace')
    expect(intents.isWebSessionCloseIntentPending(owner, 'workspace', 'closed', Date.now())).toBe(
      true
    )
    intents.reconcileWebSessionCloseIntents(owner, 'workspace', new Set())
    intents.clearWebSessionCloseIntentsForOwner(owner)
    expect(intents.isWebSessionCloseIntentPending(owner, 'workspace', 'closed', Date.now())).toBe(
      true
    )
    vi.resetModules()
    intents = await import('../runtime/web-session-close-intent')
    expect(intents.isWebSessionCloseIntentPending(owner, 'workspace', 'closed', Date.now())).toBe(
      true
    )
    expect(
      intents.isWebSessionCloseIntentPending(
        { ...owner, pairingRevision: 43 },
        'workspace',
        'closed',
        Date.now()
      )
    ).toBe(false)
    intents.clearWebSessionCloseIntent(owner, 'workspace', 'closed')
    vi.resetModules()
    intents = await import('../runtime/web-session-close-intent')
    expect(intents.isWebSessionCloseIntentPending(owner, 'workspace', 'closed', Date.now())).toBe(
      false
    )
    intents.recordWebSessionCloseIntent(owner, 'workspace', 'closed', 1)
    intents.makeWebSessionCloseIntentDurable(owner, 'workspace', 'closed', true)
    const sibling = installBrowserGlobals()
    Object.assign(sibling.window, { orcaWorkspaceWindowNative: {} })
    vi.resetModules()
    intents = await import('../runtime/web-session-close-intent')
    expect(intents.isWebSessionCloseIntentPending(owner, 'workspace', 'closed', Date.now())).toBe(
      false
    )
  }
)

it('cleans up ordinary durable close intents without persisting them as closed views', async () => {
  installBrowserGlobals()
  const owner = { environmentId: 'configured', pairingRevision: 42 }
  const intents = await import('../runtime/web-session-close-intent')
  intents.recordWebSessionCloseIntent(owner, 'workspace', 'ordinary', 1)
  intents.makeWebSessionCloseIntentDurable(owner, 'workspace', 'ordinary')
  intents.clearWebSessionCloseIntentsForOwner(owner)
  expect(intents.isWebSessionCloseIntentPending(owner, 'workspace', 'ordinary', Date.now())).toBe(
    false
  )
  vi.resetModules()
  const restored = await import('../runtime/web-session-close-intent')
  expect(restored.isWebSessionCloseIntentPending(owner, 'workspace', 'ordinary', Date.now())).toBe(
    false
  )
})

it('keeps closed views suppressed when browser storage is unavailable', async () => {
  const { storage } = installBrowserGlobals()
  vi.spyOn(storage, 'getItem').mockImplementation(() => {
    throw new Error('storage unavailable')
  })
  vi.spyOn(storage, 'setItem').mockImplementation(() => {
    throw new Error('storage full')
  })
  const intents = await import('../runtime/web-session-close-intent')
  const owner = { environmentId: 'configured', pairingRevision: 42 }
  expect(() => {
    intents.recordWebSessionCloseIntent(owner, 'workspace', 'closed', 1)
    intents.makeWebSessionCloseIntentDurable(owner, 'workspace', 'closed', true)
    intents.reconcileWebSessionCloseIntents(owner, 'workspace', new Set(['closed']))
    intents.clearWebSessionCloseIntentsForOwner(owner)
  }).not.toThrow()
  expect(intents.isWebSessionCloseIntentPending(owner, 'workspace', 'closed', Date.now())).toBe(
    true
  )
  expect(() => intents.clearWebSessionCloseIntent(owner, 'workspace', 'closed')).not.toThrow()
  expect(intents.isWebSessionCloseIntentPending(owner, 'workspace', 'closed', Date.now())).toBe(
    false
  )
})

it('does not rewrite unchanged view closures while processing host snapshots', async () => {
  const { storage } = installBrowserGlobals()
  const write = vi.spyOn(storage, 'setItem')
  const intents = await import('../runtime/web-session-close-intent')
  const owner = { environmentId: 'configured', pairingRevision: 42 }
  intents.recordWebSessionCloseIntent(owner, 'workspace', 'closed', 1)
  intents.makeWebSessionCloseIntentDurable(owner, 'workspace', 'closed', true)
  write.mockClear()
  intents.makeWebSessionCloseIntentDurable(owner, 'workspace', 'closed', true)
  intents.reconcileWebSessionCloseIntents(owner, 'workspace', new Set(['closed']))
  intents.clearWebSessionCloseIntentsForWorktree(owner, 'workspace')
  intents.clearWebSessionCloseIntentsForOwner(owner)
  expect(write).not.toHaveBeenCalled()
})

it('uses the inherited host identity to preserve native client-hosted browser pages', async () => {
  const globals = installBrowserGlobals()
  const environment = { id: 'configured', runtimeId: 'remote-runtime' }
  const response = { ok: true, result: { accepted: true } }
  const handle = { unsubscribe: vi.fn(), sendBinary: vi.fn() }
  const native = {
    runtimeEnvironments: {
      resolve: vi.fn(async () => environment),
      call: vi.fn(async () => response),
      subscribe: vi.fn(async () => handle)
    },
    browserInput: vi.fn(async () => response),
    subscribeBrowser: vi.fn(async () => handle)
  }
  Object.assign(globals.window, { orcaWorkspaceWindowNative: native })
  const { webRuntimeState } = await import('./preload-api/web-runtime-session')
  webRuntimeState.activeEnvironment = { id: 'loopback', runtimeId: 'local-runtime' } as never
  const { createRuntimeEnvironmentsApi } =
    await import('./preload-api/web-runtime-environments-api')
  const api = createRuntimeEnvironmentsApi()
  const params = { page: 'existing-page', worktree: 'id:workspace' }
  await api.call({
    selector: 'configured',
    method: 'browser.mouseMove',
    params,
    expectedEnvironmentPairingRevision: 42
  })
  expect(native.browserInput).toHaveBeenCalledWith({
    runtimeId: 'remote-runtime',
    environmentId: 'configured',
    expectedEnvironmentPairingRevision: 42,
    method: 'browser.mouseMove',
    params
  })
  expect(native.runtimeEnvironments.call).not.toHaveBeenCalled()
  const callbacks = { onResponse: vi.fn() }
  expect(
    await api.subscribe(
      {
        selector: 'configured',
        method: 'browser.screencast',
        params,
        expectedEnvironmentPairingRevision: 42
      },
      callbacks
    )
  ).toBe(handle)
  expect(native.subscribeBrowser).toHaveBeenCalledWith(
    {
      runtimeId: 'remote-runtime',
      environmentId: 'configured',
      expectedEnvironmentPairingRevision: 42,
      params
    },
    callbacks
  )
  expect(native.runtimeEnvironments.subscribe).not.toHaveBeenCalled()
})

it('inherits the main catalog and routes configured commands and streams without replacing bootstrap credentials', async () => {
  const globals = installBrowserGlobals()
  const remote = { id: 'configured', name: 'Builder', runtimeId: 'host-runtime' }
  const call = vi.fn(async () => ({
    ok: true,
    result: { repos: [] },
    _meta: { runtimeId: 'host-runtime' }
  }))
  const subscribe = vi.fn(async () => ({ unsubscribe: vi.fn(), sendBinary: vi.fn() }))
  const native = { list: vi.fn(async () => [remote]), call, subscribe }
  Object.assign(globals.window, { orcaWorkspaceWindowNative: { runtimeEnvironments: native } })
  const { webRuntimeState } = await import('./preload-api/web-runtime-session')
  const bootstrap = {
    id: 'loopback',
    name: 'This computer',
    runtimeId: 'local-runtime',
    endpoints: []
  }
  webRuntimeState.activeEnvironment = bootstrap as never
  const { createRuntimeEnvironmentsApi } =
    await import('./preload-api/web-runtime-environments-api')
  const api = createRuntimeEnvironmentsApi()
  expect((await api.list()).map((environment) => environment.id)).toEqual([
    'loopback',
    'configured'
  ])
  await api.call({
    selector: 'configured',
    method: 'repo.list',
    expectedEnvironmentPairingRevision: 42
  })
  expect(call).toHaveBeenCalledWith({
    selector: 'configured',
    method: 'repo.list',
    expectedEnvironmentPairingRevision: 42
  })
  const callbacks = { onResponse: vi.fn() }
  await api.subscribe(
    { selector: 'configured', method: 'terminal.attach', params: { terminal: 'owned-handle' } },
    callbacks
  )
  expect(subscribe).toHaveBeenCalledWith(
    { selector: 'configured', method: 'terminal.attach', params: { terminal: 'owned-handle' } },
    callbacks
  )
  expect(webRuntimeState.activeEnvironment).toBe(bootstrap)
  expect(globals.storage.getItem('orca.web.runtimeEnvironment.v1')).toBeNull()
  call.mockRejectedValueOnce(new Error('runtime_manually_disconnected'))
  await expect(api.call({ selector: 'configured', method: 'files.read' })).rejects.toThrow(
    'runtime_manually_disconnected'
  )
  expect(webRuntimeState.activeClient).toBeNull()
})
