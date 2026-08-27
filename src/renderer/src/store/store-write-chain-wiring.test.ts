/**
 * Wiring tests against the REAL app store. The telemetry patches the inner
 * api.setState, but slices close over `set` (the first creator argument) at
 * creation — index.ts must rebind it to the patched setState or every slice
 * action write goes uncounted. These tests go red if the install or the
 * rebind is dropped, which module-level tests cannot see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { STORE_WRITE_CHAIN_BREADCRUMB } from '../../../shared/store-write-chain-diagnostics'
import { STORE_WRITE_CHAIN_STACK_THRESHOLD } from './store-write-chain-telemetry'

const recordBreadcrumb = vi.fn()

beforeEach(() => {
  recordBreadcrumb.mockClear()
  // Why call-time stub: the recorder checks `window` per call, so the store
  // can be imported in a node environment and observed here.
  ;(globalThis as { window?: unknown }).window = {
    api: { crashReports: { recordBreadcrumb } }
  }
})

afterEach(async () => {
  delete (globalThis as { window?: unknown }).window
  // Drain the depth-reset microtask so bursts never leak across tests.
  await Promise.resolve()
})

function writeChainBreadcrumbs(): { name: string; data?: Record<string, unknown> }[] {
  return recordBreadcrumb.mock.calls
    .map(([args]) => args as { name: string; data?: Record<string, unknown> })
    .filter((args) => args.name === STORE_WRITE_CHAIN_BREADCRUMB)
}

describe('store write chain telemetry wiring', () => {
  it('stays silent below the threshold on the real store', async () => {
    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD - 1; i += 1) {
      useAppStore.getState().setSidebarWidth(200 + i)
    }
    expect(writeChainBreadcrumbs()).toHaveLength(0)
    await Promise.resolve()
  })

  it('counts slice-action writes, proving the rebound `set` is instrumented', () => {
    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD; i += 1) {
      useAppStore.getState().setSidebarWidth(300 + i)
    }

    const crumbs = writeChainBreadcrumbs()
    expect(crumbs).toHaveLength(1)
    expect(crumbs[0].data).toMatchObject({ depth: STORE_WRITE_CHAIN_STACK_THRESHOLD })
    // The captured call path names the dispatching slice action.
    expect(String(crumbs[0].data?.stack)).toContain('setSidebarWidth')
  })
})
