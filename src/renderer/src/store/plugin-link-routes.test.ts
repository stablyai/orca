import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensurePluginLinkRoutesLoaded,
  getPluginLinkRoutes,
  usePluginLinkRouteStore
} from './plugin-link-routes'

const route = (host: string) => ({
  pattern: { kind: 'exact' as const, host },
  destination: 'orca-browser' as const,
  pluginKey: 'pub.plugin',
  index: 0
})

function installApi(plugins: unknown): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double for the preload bridge surface this store reads.
  ;(globalThis as unknown as { window: { api?: unknown } }).window = { api: { plugins } }
}

beforeEach(() => {
  usePluginLinkRouteStore.setState({ routes: [], loaded: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('plugin link route store', () => {
  it('loads the approved table', async () => {
    installApi({ listLinkRoutes: async () => [route('app.example.com')] })
    await usePluginLinkRouteStore.getState().fetchRoutes()

    expect(getPluginLinkRoutes()).toHaveLength(1)
    expect(usePluginLinkRouteStore.getState().loaded).toBe(true)
  })

  it('reads empty before the first fetch resolves, rather than blocking the click path', () => {
    installApi({ listLinkRoutes: async () => [route('app.example.com')] })
    ensurePluginLinkRoutesLoaded()

    // The cold-click window: routing degrades to today's behavior, never to a hang.
    expect(getPluginLinkRoutes()).toEqual([])
  })

  it('fails soft when the bridge is missing', async () => {
    installApi(undefined)
    await usePluginLinkRouteStore.getState().fetchRoutes()

    expect(getPluginLinkRoutes()).toEqual([])
    expect(usePluginLinkRouteStore.getState().loaded).toBe(true)
  })

  it('fails soft when the fetch rejects', async () => {
    installApi({
      listLinkRoutes: async () => {
        throw new Error('ipc down')
      }
    })
    await usePluginLinkRouteStore.getState().fetchRoutes()

    expect(getPluginLinkRoutes()).toEqual([])
  })

  it('drops malformed entries rather than trusting the whole response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installApi({
      listLinkRoutes: async () => [
        route('good.example.com'),
        { pattern: { kind: 'exact' }, destination: 'orca-browser', pluginKey: 'x', index: 0 },
        { pattern: { kind: 'exact', host: 'x' }, destination: 'safari', pluginKey: 'x', index: 0 },
        null
      ]
    })
    await usePluginLinkRouteStore.getState().fetchRoutes()

    expect(getPluginLinkRoutes()).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })

  it('ignores a non-array response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installApi({ listLinkRoutes: async () => ({ routes: [] }) })
    await usePluginLinkRouteStore.getState().fetchRoutes()

    expect(getPluginLinkRoutes()).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('discards a stale in-flight response after a newer fetch wins', async () => {
    // Revocation case: a slow pre-revoke fetch must not overwrite the newer empty table.
    let releaseStale: (value: unknown[]) => void = () => {}
    const stale = new Promise<unknown[]>((resolve) => {
      releaseStale = resolve
    })
    let call = 0
    installApi({
      listLinkRoutes: async () => {
        call += 1
        return call === 1 ? stale : []
      }
    })

    const first = usePluginLinkRouteStore.getState().fetchRoutes()
    await usePluginLinkRouteStore.getState().fetchRoutes()
    releaseStale([route('revoked.example.com')])
    await first

    expect(getPluginLinkRoutes()).toEqual([])
  })

  it('refetches when plugins change', async () => {
    const listLinkRoutes = vi.fn(async () => [route('app.example.com')])
    const handlers: ((event: { contentPacksChanged?: boolean }) => void)[] = []
    installApi({
      listLinkRoutes,
      onChanged: (callback: (event: { contentPacksChanged?: boolean }) => void) => {
        handlers.push(callback)
        return () => {}
      }
    })

    ensurePluginLinkRoutesLoaded()
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    handlers[0]({ contentPacksChanged: true })
    await vi.waitFor(() => expect(listLinkRoutes.mock.calls.length).toBeGreaterThan(1))
  })
})
