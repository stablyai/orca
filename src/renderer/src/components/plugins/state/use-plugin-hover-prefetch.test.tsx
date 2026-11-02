// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginMarketplaceHostListing } from '../../../../../preload/api-types'
import {
  PLUGIN_PREFETCH_INTENT_MS,
  PLUGIN_PREFETCH_SESSION_CAP,
  usePluginHoverPrefetch
} from './use-plugin-hover-prefetch'

function listing(pluginKey: string): PluginMarketplaceHostListing {
  return {
    marketplaceSourceId: 'source',
    marketplaceName: 'Catalog',
    marketplaceOwner: 'acme',
    marketplaceCommit: 'c'.repeat(40),
    pluginKey,
    source: { kind: 'git', url: 'https://example.invalid/p.git', ref: 'main' },
    categories: [],
    official: false,
    bundled: false
  }
}

function setup(): {
  prefetch: ReturnType<typeof usePluginHoverPrefetch>
  fetchPreview: ReturnType<typeof vi.fn>
} {
  const fetchPreview = vi.fn().mockResolvedValue({ ok: false })
  let prefetch: ReturnType<typeof usePluginHoverPrefetch> | null = null
  function Probe(): null {
    prefetch = usePluginHoverPrefetch(fetchPreview)
    return null
  }
  act(() => createRoot(document.createElement('div')).render(<Probe />))
  return { prefetch: prefetch!, fetchPreview }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('usePluginHoverPrefetch', () => {
  it('fetches only after the pointer rests, and not when it leaves first', () => {
    const { prefetch, fetchPreview } = setup()
    prefetch.intend(listing('acme.a'))
    vi.advanceTimersByTime(PLUGIN_PREFETCH_INTENT_MS - 1)
    prefetch.cancel()
    vi.advanceTimersByTime(PLUGIN_PREFETCH_INTENT_MS)
    expect(fetchPreview).not.toHaveBeenCalled()

    prefetch.intend(listing('acme.a'))
    vi.advanceTimersByTime(PLUGIN_PREFETCH_INTENT_MS)
    expect(fetchPreview).toHaveBeenCalledOnce()
  })

  it('lets the latest hover win and stops at the session cap', () => {
    const { prefetch, fetchPreview } = setup()
    prefetch.intend(listing('acme.a'))
    prefetch.intend(listing('acme.b'))
    vi.advanceTimersByTime(PLUGIN_PREFETCH_INTENT_MS)
    expect(fetchPreview).toHaveBeenCalledOnce()
    expect(fetchPreview.mock.calls[0]?.[0].pluginKey).toBe('acme.b')

    for (let index = 0; index < PLUGIN_PREFETCH_SESSION_CAP + 3; index += 1) {
      prefetch.intend(listing(`acme.p${index}`))
      vi.advanceTimersByTime(PLUGIN_PREFETCH_INTENT_MS)
    }
    expect(fetchPreview).toHaveBeenCalledTimes(PLUGIN_PREFETCH_SESSION_CAP)
  })
})
