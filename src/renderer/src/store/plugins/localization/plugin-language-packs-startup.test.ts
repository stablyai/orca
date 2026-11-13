// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginChangeEvent } from '../../../../../shared/plugins/events/plugin-change-event'
import {
  pluginLanguageResourceId,
  type PluginLanguagePackRegistration
} from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import type * as LanguagePackModule from './plugin-language-packs'

let languagePacks: typeof LanguagePackModule

function pack(name: string): PluginLanguagePackRegistration {
  const id = `plugin:${name}` as const
  return {
    id,
    resourceLanguage: pluginLanguageResourceId(id),
    pluginKey: name,
    locale: 'en',
    catalog: {},
    coverage: 100
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

  it('retries a wedged startup request instead of joining it for the session', async () => {
    vi.useFakeTimers()
    try {
      const bridge = installBridge()
      languagePacks.ensurePluginLanguagePacksLoaded()
      // A request that is merely slow is shared, not duplicated.
      vi.advanceTimersByTime(9_000)
      languagePacks.ensurePluginLanguagePacksLoaded()
      expect(bridge.listLanguagePacks).toHaveBeenCalledTimes(1)
      // Past the join window it is wedged, so a later consumer must be able to make progress.
      vi.advanceTimersByTime(2_000)
      languagePacks.ensurePluginLanguagePacksLoaded()
      expect(bridge.listLanguagePacks).toHaveBeenCalledTimes(2)
      bridge.requests[1].resolve([pack('recovered')])
      await vi.waitFor(() =>
        expect(languagePacks.usePluginLanguagePackStore.getState().loaded).toBe(true)
      )
      expect(languagePacks.usePluginLanguagePackStore.getState().entries).toEqual([
        pack('recovered')
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
