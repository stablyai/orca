// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { useSessionsGridItems } from './use-sessions-grid-items'
import { livePtyIdsFor } from './session-grid-test-live-ptys'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

/**
 * The listener budget this hook is allowed: session inputs, the freshness epoch,
 * the workspace catalogs, and the persisted view. Publications cost
 * `events x listeners x selector work` (docs/reference/renderer-agent-status-performance.md),
 * so the hook must not grow a listener per field.
 *
 * This file mounts the hook alone, so it says nothing about per-card cost — the
 * half that scales with the number of cards is pinned in `SessionsGridPage.test.tsx`,
 * which mounts the real page.
 */
const LISTENER_BUDGET = 4

const originalState = useAppStore.getState()
let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(node: ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

function unmount(): void {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
}

function listenerCount(): number {
  const count = readStoreListenerCount()
  if (count === null) {
    throw new Error('store listener census unavailable')
  }
  return count
}

function seedTabs(count: number): void {
  const tabs: TerminalTab[] = Array.from({ length: count }, (_, i) => ({
    id: `tab-${i}`,
    ptyId: `pty-${i}`,
    worktreeId: 'wt-1',
    title: `Session ${i}`,
    createdAt: i
  })) as TerminalTab[]
  const tabsByWorktree = { 'wt-1': tabs }
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree,
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
    sessionsGridFilter: 'all',
    sessionsGridTabOrder: []
  })
}

function Probe(): null {
  useSessionsGridItems()
  return null
}

afterEach(() => {
  unmount()
  useAppStore.setState(originalState, true)
})

describe('useSessionsGridItems store subscriptions', () => {
  it('stays inside its listener budget however many sessions it lists', () => {
    seedTabs(1)
    const baseline = listenerCount()
    mount(<Probe />)
    const listeners = listenerCount() - baseline
    expect(listeners).toBeLessThanOrEqual(LISTENER_BUDGET)
    unmount()
    expect(listenerCount()).toBe(baseline)

    // The hook bundles by concern, not by session, so listing 20 costs what listing 1 costs.
    seedTabs(20)
    mount(<Probe />)
    expect(listenerCount() - baseline).toBe(listeners)
  })
})
