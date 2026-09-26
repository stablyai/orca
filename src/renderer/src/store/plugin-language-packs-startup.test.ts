// @vitest-environment happy-dom

import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginChangeEvent } from '../../../shared/plugins/plugin-change-event'
import {
  pluginLanguageResourceId,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/plugin-language-pack-artifact'
import type * as LanguagePackModule from './plugin-language-packs'

let languagePacks: typeof LanguagePackModule

function pack(name: string): PluginLanguagePackRegistration {
  const id = `plugin:${name}` as const
  return {
    id,
    resourceLanguage: pluginLanguageResourceId(id),
    pluginKey: name,
    locale: 'en',
    catalog: {}
  }
}

function installBridge() {
  const requests: ReturnType<typeof Promise.withResolvers<PluginLanguagePackRegistration[]>>[] = []
  const listLanguagePacks = vi.fn(() => {
    const request = Promise.withResolvers<PluginLanguagePackRegistration[]>()
    requests.push(request)
    return request.promise
  })
  const listeners: ((event: PluginChangeEvent) => void)[] = []
  const onChanged = vi.fn((listener: (event: PluginChangeEvent) => void) => {
    listeners.push(listener)
    return () => {}
  })
  vi.stubGlobal('api', { plugins: { listLanguagePacks, onChanged } })
  return { requests, listLanguagePacks, onChanged, listeners }
}

beforeEach(async () => {
  vi.resetModules()
  languagePacks = await import('./plugin-language-packs')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('plugin language-pack startup ownership', () => {
  it.each([false, true])(
    'shares one load across mounted consumers (StrictMode: %s)',
    async (strict) => {
      const bridge = installBridge()
      const wrapper = strict ? StrictMode : undefined
      const first = renderHook(() => languagePacks.usePluginLanguagePacks(), { wrapper })
      const second = renderHook(() => languagePacks.usePluginLanguagePacks(), { wrapper })
      const dispatches = bridge.listLanguagePacks.mock.calls.length
      const result = [pack('startup')]
      await act(async () => {
        for (const request of bridge.requests) {
          request.resolve(result)
        }
        await Promise.all(bridge.requests.map((request) => request.promise))
      })
      expect(dispatches).toBe(1)
      expect(bridge.onChanged).toHaveBeenCalledTimes(1)
      expect(first.result.current).toEqual(result)
      expect(second.result.current).toBe(first.result.current)
    }
  )

  it.each(['resolve', 'reject'] as const)(
    'keeps a newer refresh pending after an older request %ss',
    async (settlement) => {
      const bridge = installBridge()
      const store = languagePacks.usePluginLanguagePackStore
      const older = store.getState().fetchPacks()
      const newer = store.getState().fetchPacks()
      if (settlement === 'resolve') {
        bridge.requests[0].resolve([pack('old')])
      } else {
        bridge.requests[0].reject(new Error('old failure'))
      }
      await older
      expect(store.getState().loaded).toBe(false)
      languagePacks.ensurePluginLanguagePacksLoaded()
      const dispatches = bridge.listLanguagePacks.mock.calls.length
      for (const request of bridge.requests.slice(1)) {
        request.resolve([pack('current')])
      }
      await newer
      expect(dispatches).toBe(2)
      expect(store.getState().packs).toEqual([pack('current')])
    }
  )

  it('allows a content-change refresh to supersede startup while ignoring unrelated changes', async () => {
    const bridge = installBridge()
    languagePacks.ensurePluginLanguagePacksLoaded()
    bridge.listeners[0]({ contentPacksChanged: false })
    expect(bridge.listLanguagePacks).toHaveBeenCalledTimes(1)
    bridge.listeners[0]({ contentPacksChanged: true })
    expect(bridge.listLanguagePacks).toHaveBeenCalledTimes(2)
    bridge.requests[1].resolve([pack('changed')])
    await bridge.requests[1].promise
    bridge.requests[0].resolve([pack('old')])
    await bridge.requests[0].promise
    languagePacks.ensurePluginLanguagePacksLoaded()
    expect(bridge.listLanguagePacks).toHaveBeenCalledTimes(2)
    expect(languagePacks.usePluginLanguagePackStore.getState().packs).toEqual([pack('changed')])
  })

  it('keeps the shared startup request alive after the first consumer unmounts', async () => {
    const bridge = installBridge()
    const first = renderHook(() => languagePacks.usePluginLanguagePacks())
    first.unmount()
    const second = renderHook(() => languagePacks.usePluginLanguagePacks())
    const dispatches = bridge.listLanguagePacks.mock.calls.length
    await act(async () => {
      for (const request of bridge.requests) {
        request.resolve([pack('retained')])
      }
      await Promise.all(bridge.requests.map((request) => request.promise))
    })
    expect(dispatches).toBe(1)
    expect(second.result.current).toEqual([pack('retained')])
  })

  it('retains fail-closed loading and permits an explicit retry after rejection', async () => {
    const bridge = installBridge()
    const store = languagePacks.usePluginLanguagePackStore
    const failed = store.getState().fetchPacks()
    bridge.requests[0].reject(new Error('bridge unavailable'))
    await failed
    expect(store.getState().loaded).toBe(true)
    expect(store.getState().packs).toEqual([])
    languagePacks.ensurePluginLanguagePacksLoaded()
    expect(bridge.listLanguagePacks).toHaveBeenCalledTimes(1)
    const retry = store.getState().fetchPacks()
    bridge.requests[1].resolve([pack('retry')])
    await retry
    expect(store.getState().packs).toEqual([pack('retry')])
  })

  it('finishes without an older bridge API and admits a later explicit refresh', async () => {
    vi.stubGlobal('api', {})
    languagePacks.ensurePluginLanguagePacksLoaded()
    expect(languagePacks.usePluginLanguagePackStore.getState().loaded).toBe(true)
    const bridge = installBridge()
    const refresh = languagePacks.usePluginLanguagePackStore.getState().fetchPacks()
    bridge.requests[0].resolve([pack('available')])
    await refresh
    expect(bridge.listLanguagePacks).toHaveBeenCalledTimes(1)
    expect(languagePacks.usePluginLanguagePackStore.getState().packs).toEqual([pack('available')])
  })
})
