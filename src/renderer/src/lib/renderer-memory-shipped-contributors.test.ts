import { afterEach, describe, expect, it } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from './pane-manager/pane-manager-registry'
import {
  MAX_PROFILE_COUNTS,
  MAX_TREND_COUNTS,
  collectRendererMemoryProfileCounts,
  collectRendererMemoryTrendCounts,
  createRendererMemoryCensus
} from './renderer-memory-profile'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'

/**
 * Drives the contributors the app actually registers — importing ../store and
 * pane-manager-registry for their registration side effects — instead of
 * hand-written stand-ins that can only restate the test's own setup.
 */

const paneManager = {
  resetWebglTextureAtlases: () => undefined,
  getPaneCount: () => 3,
  getPanes: () =>
    [1, 2, 3].map((id) => ({
      id,
      terminal: { cols: 200, buffer: { active: { length: 5000 } } }
    }))
}

/** Saturates every slice limit so each contributor emits its widest census. */
function fillStoreWithProbeSlices(): string[] {
  const keys = Array.from({ length: 40 }, (_, index) => `__profileProbe${index}`)
  useAppStore.setState(
    Object.fromEntries(
      keys.map((key, index) => [key, Array.from({ length: index + 1 }, () => 'x'.repeat(64))])
    ) as unknown as Partial<AppState>
  )
  return keys
}

afterEach(() => {
  unregisterLivePaneManager(paneManager)
})

describe('shipped renderer memory contributors', () => {
  it('fits the widest census of every registered contributor inside MAX_PROFILE_COUNTS', () => {
    // Why the real registry: a fake census cannot notice the store raising its
    // slice limit, a fourth contributor arriving, or terminals adding keys —
    // any of which silently truncates the near-death profile mid-contributor.
    const probeKeys = fillStoreWithProbeSlices()
    registerLivePaneManager(paneManager)

    const counts = collectRendererMemoryProfileCounts()
    const prefixes = new Set(Object.keys(counts).map((key) => key.split('.')[0]))

    expect(Object.keys(counts).length).toBeLessThanOrEqual(MAX_PROFILE_COUNTS)
    expect([...prefixes].sort()).toEqual(['store', 'storeKB', 'terminals'])
    // Truncation stops mid-contributor, so the last registered one loses keys first.
    expect(counts['terminals.estBufferKB']).toBeGreaterThan(0)
    expect(counts['storeKB.__totalKB']).toBeGreaterThan(0)
    expect(Object.keys(counts).filter((key) => key.startsWith('store.'))).toHaveLength(20)
    expect(probeKeys.some((key) => counts[`store.${key}`] !== undefined)).toBe(true)
  })

  it('carries both byte contributors on the routine trend within MAX_TREND_COUNTS', () => {
    // Why terminals too: the sub-A leak grows outside the zustand store, and
    // xterm scrollback is the byte source storeKB structurally cannot see.
    fillStoreWithProbeSlices()
    registerLivePaneManager(paneManager)

    const counts = collectRendererMemoryTrendCounts(createRendererMemoryCensus())

    expect(Object.keys(counts).length).toBeLessThanOrEqual(MAX_TREND_COUNTS)
    expect(counts['storeKB.__totalKB']).toBeGreaterThan(0)
    // 3 panes x 5000 rows x 200 cols x 16B ~= 46MB of scrollback.
    expect(counts['terminals.estBufferKB']).toBeGreaterThan(40_000)
    expect(Object.keys(counts).filter((key) => key.startsWith('terminals.'))).toHaveLength(2)
  })

  it('reads each contributor once when a sample both trends and profiles', () => {
    // Why: crossing 90/95% runs both censuses in one pass, with no heap headroom
    // left to walk the store twice.
    fillStoreWithProbeSlices()
    registerLivePaneManager(paneManager)
    const census = createRendererMemoryCensus()

    collectRendererMemoryTrendCounts(census)
    const before = census.get('storeKB')
    collectRendererMemoryProfileCounts(census)

    expect(before).toBeDefined()
    expect(census.get('storeKB')).toBe(before)
    expect(census.get('terminals')).toBeDefined()
  })
})
