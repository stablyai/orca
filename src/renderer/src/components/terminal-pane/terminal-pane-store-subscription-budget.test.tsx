// @vitest-environment happy-dom
// Every retained tab multiplies synchronous Zustand listener visits; cap subscriptions and fold stable actions/duplicate reads (renderer-agent-status-performance.md).
import { act, type ReactNode } from 'react'
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

/** One extra listener costs a visit per publication for every retained tab; consult the performance doc before raising. */
const TERMINAL_PANE_LISTENER_BUDGET = 15
/** Compare with pre-fold mount cost: one listener per stable action plus folded duplicate reads. */
const PRE_FOLD_LISTENERS_PER_PANE = 44

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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscription budget reads only these props; every other pane prop is optional or unused while hidden.
    {
      tabId,
      worktreeId: 'repo-1::/repo/worktrees/budget',
      cwd: '/repo/worktrees/budget',
      isActive: false,
      isVisible: false
    } as never
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

    // Measure a second pane so the shared provider’s subscriptions are excluded from marginal cost.
    rerender(
      <LinkRoutingPreferenceDialogProvider>
        <PaneProbe tabId="tab-1" />
        <PaneProbe tabId="tab-2" />
      </LinkRoutingPreferenceDialogProvider>
    )
    const perPane = listenerCount() - withOnePane

    expect(perPane).toBe(TERMINAL_PANE_LISTENER_BUDGET)
    expect(perPane).toBeLessThan(PRE_FOLD_LISTENERS_PER_PANE)
    // Stable actions, four duplicate unified-tab reads, one dead dispatch-status read,
    // one retired per-pane Chat UI setting read.
    expect(PRE_FOLD_LISTENERS_PER_PANE - perPane).toBe(TERMINAL_PANE_STORE_ACTION_KEYS.length + 6)

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
})
