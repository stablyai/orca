/**
 * Wiring tests proving every standalone zustand store joins the app store's
 * SHARED write-chain counter. A cascade can cross stores; if any store held a
 * private counter (or skipped the `set` rebind), its writes would escape and
 * an absent breadcrumb could no longer be read as "not store-mediated".
 * Separate file from store-write-chain-wiring.test.ts so the shared tracker's
 * capture floor starts fresh here (vitest isolates module state per file).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { usePluginPanelsStore } from './plugin-panels'
import { usePluginLanguagePackStore } from './plugin-language-packs'
import { useRunningTerminalCloseConfirmStore } from './running-terminal-close-confirm'
import { STORE_WRITE_CHAIN_BREADCRUMB } from '../../../shared/store-write-chain-diagnostics'
import { STORE_WRITE_CHAIN_STACK_THRESHOLD } from './store-write-chain-telemetry'

const recordBreadcrumb = vi.fn()
let nowMs = 0

beforeEach(() => {
  recordBreadcrumb.mockClear()
  // Step past the shared tracker's renderer-side capture floor between tests.
  nowMs += 100_000
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
  // Why call-time stub: the recorder checks `window` per call, so the stores
  // can be imported in a node environment and observed here. No `plugins`
  // bridge on purpose — fetch actions take their synchronous fail-soft path.
  ;(globalThis as { window?: unknown }).window = {
    api: { crashReports: { recordBreadcrumb } }
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  delete (globalThis as { window?: unknown }).window
  // Drain the depth-reset microtask so bursts never leak across tests.
  await Promise.resolve()
})

function writeChainBreadcrumbs(): { name: string; data?: Record<string, unknown> }[] {
  return recordBreadcrumb.mock.calls
    .map(([args]) => args as { name: string; data?: Record<string, unknown> })
    .filter((args) => args.name === STORE_WRITE_CHAIN_BREADCRUMB)
}

describe('cross-store write chain telemetry wiring', () => {
  it('sums app-store and plugin-panels writes on one counter', () => {
    // Interleaved so neither store alone reaches the threshold: only the
    // shared counter sees the combined chain cross it.
    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD; i += 1) {
      if (i % 2 === 0) {
        useAppStore.getState().setSidebarWidth(200 + i)
      } else {
        usePluginPanelsStore.getState().setPanelHealth(`tab-${i}`, 'error')
      }
    }

    const crumbs = writeChainBreadcrumbs()
    expect(crumbs).toHaveLength(1)
    expect(crumbs[0].data).toMatchObject({ depth: STORE_WRITE_CHAIN_STACK_THRESHOLD })
  })

  it('counts running-terminal-close-confirm action writes through the rebound set', () => {
    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD; i += 1) {
      // Same tab id: every call after the first merges, and each merge writes.
      useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
        terminalTabId: 'tab-under-test',
        tabLabel: 'zsh',
        copyKind: 'command',
        onConfirm: () => {}
      })
    }

    const crumbs = writeChainBreadcrumbs()
    expect(crumbs).toHaveLength(1)
    expect(String(crumbs[0].data?.stack)).toContain('requestRunningTerminalCloseConfirm')
    useRunningTerminalCloseConfirmStore.setState({ runningTerminalCloseConfirm: null })
  })

  it('counts plugin-language-pack action writes through the rebound set', () => {
    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD; i += 1) {
      // No plugins bridge stubbed: fetchPacks writes synchronously (fail-soft
      // path runs before any await), so the burst stays in one flush.
      void usePluginLanguagePackStore.getState().fetchPacks()
    }

    const crumbs = writeChainBreadcrumbs()
    expect(crumbs).toHaveLength(1)
    expect(String(crumbs[0].data?.stack)).toContain('fetchPacks')
  })
})
