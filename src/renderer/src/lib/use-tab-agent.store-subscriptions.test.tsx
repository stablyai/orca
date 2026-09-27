// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { useTabAgent } from './use-tab-agent'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

/**
 * The listener budget this hook is allowed. It mounts once per tab-bar tab AND once
 * per session-grid card, so it is the steepest per-instance cost in the renderer:
 * a publication costs `events x listeners x selector work`
 * (docs/reference/renderer-agent-status-performance.md), and this hook multiplies
 * that by every mounted surface. It reads eleven values from the store and pays for
 * ONE listener; never add a loose subscription beside the bundle.
 */
const LISTENER_BUDGET = 1

const initialAppState = useAppStore.getInitialState()
let root: Root | null = null
let container: HTMLDivElement | null = null

const tab: TerminalTab = {
  id: 'tab-1',
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  title: 'Terminal 1',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function Probe({ tab: probeTab }: { tab: TerminalTab }): null {
  useTabAgent(probeTab)
  return null
}

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

afterEach(() => {
  unmount()
  useAppStore.setState(initialAppState, true)
})

describe('useTabAgent store subscriptions', () => {
  it('stays inside its listener budget and releases every listener on unmount', () => {
    const baseline = listenerCount()
    mount(createElement(Probe, { tab }))
    const listeners = listenerCount() - baseline
    expect(listeners).toBeLessThanOrEqual(LISTENER_BUDGET)
    unmount()
    expect(listenerCount()).toBe(baseline)
  })

  // Nothing here is per-tab state, so N instances cost N times one instance and no more.
  it('costs the same per instance however many tabs are mounted', () => {
    const baseline = listenerCount()
    mount(createElement(Probe, { tab }))
    const one = listenerCount() - baseline
    unmount()

    const tabs = Array.from({ length: 5 }, (_, i) => ({
      ...tab,
      id: `tab-${i}`,
      ptyId: `pty-${i}`
    }))
    mount(
      createElement('div', null, ...tabs.map((t) => createElement(Probe, { key: t.id, tab: t })))
    )
    expect(listenerCount() - baseline).toBe(5 * one)
  })
})
