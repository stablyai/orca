// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { AutomationRunsDashboardEntry } from './automation-runs-dashboard-model'
import { AutomationRunsTable } from './AutomationRunsTable'

vi.mock('@tanstack/react-virtual', async () => {
  const { createVirtualizerStub } = await import('./virtualizer-test-stub')
  return { useVirtualizer: createVirtualizerStub() }
})

function entries(
  count: number,
  overrides: { hostLabel?: string; scope?: AutomationRunsDashboardEntry['scope'] } = {}
): AutomationRunsDashboardEntry[] {
  const automation = { id: 'automation', name: 'Daily check' } as Automation
  const row = {
    key: 'row',
    automation,
    catalogRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    hostLabel: overrides.hostLabel ?? 'Local Mac',
    usageSummary: null
  } as const
  return Array.from({ length: count }, (_, index) => ({
    key: `row:run-${index}`,
    hostKey: 'desktop:self',
    searchText: `daily check run ${index} local mac`,
    row,
    run: {
      id: `run-${index}`,
      automationId: automation.id,
      title: `Run ${index}`,
      scheduledFor: index,
      trigger: 'scheduled',
      status: 'completed'
    } as AutomationRun,
    scope: overrides.scope ?? 'local'
  }))
}

/** The load-more guard reads the scroller's geometry, which happy-dom leaves at 0. */
function scrollTo(
  scroller: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }
): void {
  for (const [property, value] of Object.entries(geometry)) {
    Object.defineProperty(scroller, property, { value, configurable: true })
  }
  act(() => {
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

describe('AutomationRunsTable load more', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderTable(props: {
    loading: boolean
    hasMore: boolean
    onLoadMore: () => void
  }): void {
    act(() =>
      root.render(
        <AutomationRunsTable
          entries={entries(40)}
          loading={props.loading}
          hasMore={props.hasMore}
          onLoadMore={props.onLoadMore}
          onOpenRun={() => {}}
        />
      )
    )
  }

  function scroller(): HTMLElement {
    const element = container.querySelector<HTMLElement>('.scrollbar-sleek')
    if (!element) {
      throw new Error('runs table has no scroll container')
    }
    return element
  }

  it('asks once per page, not once per scroll event the same page fires', () => {
    const onLoadMore = vi.fn()
    const geometry = { scrollTop: 1760, scrollHeight: 2360, clientHeight: 600 }
    renderTable({ loading: false, hasMore: true, onLoadMore })

    scrollTo(scroller(), geometry)
    // Scroll momentum keeps firing before the request settles; a second ask would
    // fetch the same cursor twice.
    renderTable({ loading: true, hasMore: true, onLoadMore })
    scrollTo(scroller(), geometry)
    scrollTo(scroller(), geometry)

    expect(onLoadMore).toHaveBeenCalledTimes(1)

    // Once the page settles the next stretch of scrolling may ask again.
    renderTable({ loading: false, hasMore: true, onLoadMore })
    scrollTo(scroller(), geometry)

    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })
})
