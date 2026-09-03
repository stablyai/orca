// @vitest-environment happy-dom
/**
 * TerminalPane mounts once per retained tab, and zustand visits every listener
 * synchronously on every publication, so the per-pane subscription count is a
 * direct multiplier on agent-status burn (docs/reference/renderer-agent-status-performance.md).
 *
 * On `main` one mounted pane opened 48 listeners; 31 of them selected values that
 * can never change — 27 store actions and 4 duplicate reads of one unified tab.
 */
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { LinkRoutingPreferenceDialogProvider } from '@/components/link-routing-preference-dialog'
import { useTerminalPaneController } from './use-terminal-pane-controller'
import {
  TERMINAL_PANE_STORE_ACTION_KEYS,
  useTerminalPaneStoreActions
} from './use-terminal-pane-store-actions'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Pinned budget for one mounted TerminalPane. Raising it costs one extra listener
 * visit per store publication for every retained tab in the app — read the doc
 * above before you do.
 */
const TERMINAL_PANE_LISTENER_BUDGET = 17
/** What the same mount cost before the stable-action and unified-tab folds. */
const PRE_FOLD_LISTENERS_PER_PANE = 48

const originalState = useAppStore.getState()

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(node: ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

function rerender(node: ReactNode): void {
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

function PaneProbe({ tabId }: { tabId: string }): null {
  useTerminalPaneController(
    {
      tabId,
      worktreeId: 'repo-1::/repo/worktrees/budget',
      cwd: '/repo/worktrees/budget',
      isActive: false,
      isVisible: false
    } as never,
    createRef()
  )
  return null
}

afterEach(() => {
  unmount()
  useAppStore.setState(originalState, true)
})

describe('TerminalPane store subscription budget', () => {
  it('stays inside the pinned per-pane listener budget', () => {
    const baseline = listenerCount()
    mount(
      <LinkRoutingPreferenceDialogProvider>
        <PaneProbe tabId="tab-1" />
      </LinkRoutingPreferenceDialogProvider>
    )
    const withOnePane = listenerCount()

    // The provider itself subscribes, so the marginal cost of a pane is measured
    // by adding a second one to the already-mounted tree.
    rerender(
      <LinkRoutingPreferenceDialogProvider>
        <PaneProbe tabId="tab-1" />
        <PaneProbe tabId="tab-2" />
      </LinkRoutingPreferenceDialogProvider>
    )
    const perPane = listenerCount() - withOnePane

    expect(perPane).toBe(TERMINAL_PANE_LISTENER_BUDGET)
    expect(perPane).toBeLessThan(PRE_FOLD_LISTENERS_PER_PANE)
    // 27 stable actions plus four duplicate unified-tab reads.
    expect(PRE_FOLD_LISTENERS_PER_PANE - perPane).toBe(TERMINAL_PANE_STORE_ACTION_KEYS.length + 4)

    unmount()
    expect(listenerCount()).toBe(baseline)
  })

  it('scales linearly, so 20 retained tabs cost 20x the budget and not more', () => {
    const baseline = listenerCount()
    const tabIds = Array.from({ length: 20 }, (_, index) => `tab-${index}`)
    mount(
      <LinkRoutingPreferenceDialogProvider>
        {tabIds.map((tabId) => (
          <PaneProbe key={tabId} tabId={tabId} />
        ))}
      </LinkRoutingPreferenceDialogProvider>
    )

    const paneListeners = listenerCount() - baseline
    // The provider's own subscriptions ride along; they do not scale with panes.
    expect(paneListeners).toBeLessThanOrEqual(TERMINAL_PANE_LISTENER_BUDGET * 20 + 8)
    expect(paneListeners).toBeLessThan(PRE_FOLD_LISTENERS_PER_PANE * 20)

    unmount()
    expect(listenerCount()).toBe(baseline)
  })

  it('binds the live store actions without opening a listener for any of them', () => {
    let bound: Record<string, unknown> | null = null
    function ActionsProbe(): null {
      bound = useTerminalPaneStoreActions() as unknown as Record<string, unknown>
      return null
    }

    const baseline = listenerCount()
    mount(<ActionsProbe />)

    expect(listenerCount()).toBe(baseline)
    const state = useAppStore.getState() as unknown as Record<string, unknown>
    const boundActions = bound as Record<string, unknown> | null
    if (!boundActions) {
      throw new Error('probe did not render')
    }
    expect(Object.keys(boundActions).sort()).toEqual([...TERMINAL_PANE_STORE_ACTION_KEYS].sort())
    for (const key of TERMINAL_PANE_STORE_ACTION_KEYS) {
      expect(boundActions[key]).toBe(state[key])
    }
  })

  it('never reassigns one of the bound actions, which is what makes getState() safe', () => {
    const before = useAppStore.getState() as unknown as Record<string, unknown>
    const snapshot = new Map(TERMINAL_PANE_STORE_ACTION_KEYS.map((key) => [key, before[key]]))

    act(() => {
      useAppStore.getState().markWorktreeUnread('repo-1::/repo/worktrees/budget')
      useAppStore.getState().clearWorktreeUnread('repo-1::/repo/worktrees/budget')
      useAppStore.getState().setRuntimePaneTitle('tab-1', 1, 'title')
      useAppStore.getState().clearRuntimePaneTitle('tab-1', 1)
      useAppStore.getState().suppressPtyExit('pty-1')
      useAppStore.getState().consumeSuppressedPtyExit('pty-1')
      useAppStore.getState().setCacheTimerStartedAt('cache-1', Date.now())
    })

    const after = useAppStore.getState() as unknown as Record<string, unknown>
    const moved = TERMINAL_PANE_STORE_ACTION_KEYS.filter((key) => after[key] !== snapshot.get(key))
    expect(moved).toEqual([])
  })
})
