// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { usePluginReviewQueue } from './use-plugin-review-queue'

let root: Root | null = null
let queue: ReturnType<typeof usePluginReviewQueue> | null = null

function Harness(): null {
  queue = usePluginReviewQueue()
  return null
}

function pending(pluginKey: string): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: 'f',
    name: pluginKey,
    version: '1.0.0',
    publisher: 'acme',
    status: 'pending',
    needsReconsent: true,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0
  }
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
})

describe('usePluginReviewQueue', () => {
  it('opens each queued review in turn, skipping ones no longer needing review', async () => {
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Harness />))
    await act(async () => queue?.enqueue(['a', 'b', 'c']))
    expect(queue?.reviewKey).toBe('a')

    // Why: "b" was approved elsewhere meanwhile, so only "c" still needs review.
    await act(async () => queue?.advance([pending('c')]))
    expect(queue?.reviewKey).toBe('c')
    await act(async () => queue?.advance([]))
    expect(queue?.reviewKey).toBeNull()
  })
})
