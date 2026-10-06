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

describe('AutomationRunsTable virtualization', () => {
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

  it('keeps a 10,000-run history to a bounded number of mounted rows', () => {
    act(() => {
      root.render(
        <AutomationRunsTable
          entries={entries(10_000)}
          loading={false}
          hasMore={false}
          onLoadMore={() => {}}
          onOpenRun={() => {}}
        />
      )
    })

    const mountedRows = container.querySelectorAll('[data-testid="automation-runs-row"]')
    expect(mountedRows).toHaveLength(21)
  })
})

describe('AutomationRunsTable rows', () => {
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

  function render(node: React.JSX.Element): void {
    act(() => root.render(node))
  }

  function rows(): NodeListOf<HTMLButtonElement> {
    return container.querySelectorAll<HTMLButtonElement>('[data-testid="automation-runs-row"]')
  }

  it('fills every column of a row from the entry it stands for', () => {
    render(
      <AutomationRunsTable
        entries={entries(1)}
        loading={false}
        hasMore={false}
        onLoadMore={() => {}}
        onOpenRun={() => {}}
      />
    )

    const row = rows()[0]
    expect(row.textContent).toContain('Daily check')
    expect(row.textContent).toContain('Run 0')
    expect(row.textContent).toContain('Local Mac')
    expect(row.textContent).toContain('scheduled')
    expect(row.textContent).toContain('Done')
  })

  it('names the scope when the row carries no host label', () => {
    render(
      <AutomationRunsTable
        entries={entries(1, { hostLabel: '', scope: 'remote' })}
        loading={false}
        hasMore={false}
        onLoadMore={() => {}}
        onOpenRun={() => {}}
      />
    )

    // An unlabeled host still has to say where the run happened.
    expect(rows()[0].textContent).toContain('Remote')
  })

  it('opens the entry belonging to the clicked row, not the first one', () => {
    const onOpenRun = vi.fn()
    const rendered = entries(5)
    render(
      <AutomationRunsTable
        entries={rendered}
        loading={false}
        hasMore={false}
        onLoadMore={() => {}}
        onOpenRun={onOpenRun}
      />
    )

    act(() => rows()[3].click())

    expect(onOpenRun).toHaveBeenCalledExactlyOnceWith(rendered[3])
  })

  it('shows the spinner only until the first page arrives', () => {
    render(
      <AutomationRunsTable
        entries={[]}
        loading={true}
        hasMore={false}
        onLoadMore={() => {}}
        onOpenRun={() => {}}
      />
    )

    expect(container.textContent).toContain('Loading runs')
    expect(rows()).toHaveLength(0)

    // A refresh over rows already on screen must not blank them back to a spinner.
    render(
      <AutomationRunsTable
        entries={entries(3)}
        loading={true}
        hasMore={false}
        onLoadMore={() => {}}
        onOpenRun={() => {}}
      />
    )

    expect(container.textContent).not.toContain('Loading runs')
    expect(rows()).toHaveLength(3)
  })

  it('distinguishes an empty history from one still loading', () => {
    render(
      <AutomationRunsTable
        entries={[]}
        loading={false}
        hasMore={false}
        onLoadMore={() => {}}
        onOpenRun={() => {}}
      />
    )

    expect(container.textContent).toContain('No runs yet')
    expect(container.textContent).not.toContain('Loading runs')
  })
})

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

  it('asks for the next page once the scroll reaches the end', () => {
    const onLoadMore = vi.fn()
    renderTable({ loading: false, hasMore: true, onLoadMore })

    scrollTo(scroller(), { scrollTop: 1760, scrollHeight: 2360, clientHeight: 600 })

    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('stays quiet while the scroll is still far from the end', () => {
    const onLoadMore = vi.fn()
    renderTable({ loading: false, hasMore: true, onLoadMore })

    scrollTo(scroller(), { scrollTop: 0, scrollHeight: 2360, clientHeight: 600 })

    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('stays quiet when the host has no further pages', () => {
    const onLoadMore = vi.fn()
    renderTable({ loading: false, hasMore: false, onLoadMore })

    scrollTo(scroller(), { scrollTop: 1760, scrollHeight: 2360, clientHeight: 600 })

    expect(onLoadMore).not.toHaveBeenCalled()
  })

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
